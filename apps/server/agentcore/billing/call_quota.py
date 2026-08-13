"""Per-call platform quota gate — the brake on cloud in-process LLM calls.

The sidecar reaches models through ``/inference/v1/chat/completions``, so its
route-level ``preflight_llm_credentials`` already re-checks quota on **every**
upstream call. Cloud in-process turns skip that hop: one route preflight
admitted the turn and nothing looked again, so turns started together all read
the same pre-turn number, and a Multi-Agent turn's worker fan-out could run
unbounded workers and rounds on that single reading. This module restores parity
at :class:`~agentcore.llm.call_fence.ObservingLLMProvider` — the fence every leaf
call already passes through — so both paths brake at the same granularity
(成本配额与计费 §一).

Scope follows the money split the ledger already draws: a call is gated when its
``credential_source`` is not ``user`` — i.e. the deployment's platform / vendor
key pays for it, and ``cost_total_nano`` (the column ``enforce_quota`` SUMs) will
be non-zero. BYOK stays ungated (用户自担上游账单, 拍板 2026-07-20).

Refusal raises :class:`LLMQuotaExceededError` — the same leaf-family error the
sidecar's 429 ``QUOTA_EXCEEDED`` envelope maps to, carrying the gate's own copy
and ``retryable=False``. A mid-turn refusal therefore surfaces identically on
both paths, and neither burns a retry budget on a refusal nothing clears.

Freshness is bounded by ledger drain, **not** by turn end: in-process metering
enqueues each call's spend as it completes (``materialize_runs=True``) and the
drain loop upserts ``cost_events`` continuously, so a check sees every call that
finished a drain cycle ago. Calls still in flight are not counted — this narrows
the oversell window from a whole turn to one drain cycle; it does not reserve
budget up front (which would need a counter this design deliberately omits).

Reads run on the **telemetry** pool — where the ledger is written anyway — so a
per-call check cannot contend with content writes on the primary pool.
"""

from __future__ import annotations

from agentcore.billing.call_meter import PROXY_LLM_SCENARIO
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import LLMQuotaExceededError, QuotaExceededError
from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.db.base import telemetry_session_factory
from agentcore.db.repositories import CostEventRepository, UserRepository
from agentcore.llm.pricing import resolve_credential_source

logger = get_logger(__name__)


async def enforce_call_quota(
    *,
    provider_name: str | None = None,
    model: str = "",
    scenario: str | None = None,
) -> None:
    """Refuse one upstream call when the paying account's quota is spent.

    Returns without touching the DB when the call is not platform-funded: a BYOK
    leaf, a proxy-forwarded call (``/inference/`` already gated that same physical
    call at its route — checking again would double-read the hottest route), or no
    bound ``user_id`` (BYOK 设置·测连 probes / evals have no account to charge).
    """
    if scenario == PROXY_LLM_SCENARIO:
        return
    if resolve_credential_source(provider_name=provider_name, model=model) == "user":
        return
    user_id = get_log_value("user_id")
    if not user_id:
        return

    async with telemetry_session_factory() as session:
        user = await UserRepository(session).get_by_id(user_id)
        if user is None:
            return
        try:
            await enforce_quota(
                CostEventRepository(session),
                user_id,
                limits=QuotaLimits.for_user(user),
            )
        except QuotaExceededError as e:
            logger.info(
                "billing.call_quota_refused",
                user_id=user_id,
                dimension=e.dimension,
                used=e.used,
                limit=e.limit,
                model=model or "",
                scenario=scenario or "",
            )
            # Leaf-family twin: same code / CTA, but an LLMError so the turn's
            # error surfacing treats it exactly like the sidecar's 429 hop.
            raise LLMQuotaExceededError(e.message) from e
