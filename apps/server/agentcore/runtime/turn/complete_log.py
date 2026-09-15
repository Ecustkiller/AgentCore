"""Captain ``chat.turn_complete`` close line (observation only).

Cloud ``turn_runner`` and sidecar ``startTurn`` share this so Phase-0 fields
(``prepare_ms`` / ``assemble_ms`` / ``ttft_*``) have one owner. Cloud write-back
of a sidecar turn still logs ``chat.local_turn_recorded`` only — do not emit
``chat.turn_complete`` from ``_finalize_local``.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from agentcore.conversation.common import preview
from agentcore.conversation.turn_stats import turn_worker_stats
from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.runtime.turn.latency import get_turn_latency

logger = get_logger(__name__)

_OUTCOMES = frozenset({"ok", "partial", "paused", "error"})


def log_chat_turn_complete(
    result: Mapping[str, Any],
    *,
    duration_ms: int,
    llm_credentials: Any | None = None,
) -> None:
    """Emit the captain close line, including Phase-0 fields (nulls stay null)."""
    finish = result.get("finish_reason")
    delegated, workers = turn_worker_stats(result)
    collab = result.get("collab") or {}
    extra: dict[str, object] = {}
    model = ""
    if llm_credentials is not None:
        model = getattr(llm_credentials, "default_model", "") or ""
    if model:
        extra["model"] = model
    cred_src = get_log_value("credential_source")
    if cred_src:
        extra["credential_source"] = cred_src
    provider_id = get_log_value("provider_id")
    if provider_id:
        extra["provider_id"] = provider_id
    probe = get_turn_latency()
    phase0 = (
        probe.as_log_fields()
        if probe is not None
        else {
            "prepare_ms": None,
            "assemble_ms": None,
            "ttft_reasoning_ms": None,
            "ttft_content_ms": None,
        }
    )
    outcome = result.get("outcome")
    logger.info(
        "chat.turn_complete",
        finish_reason=getattr(finish, "value", finish),
        **({"outcome": outcome} if outcome in _OUTCOMES else {}),
        rounds=result.get("rounds", 0),
        input_tokens=result.get("input_tokens", 0),
        output_tokens=result.get("output_tokens", 0),
        reasoning_tokens=result.get("reasoning_tokens", 0),
        reply_chars=len(result.get("content") or ""),
        reply_preview=preview(result.get("content") or ""),
        delegated=delegated,
        workers=workers,
        boundary_yields=collab.get("boundary_yields", 0),
        scope_signals=collab.get("scope_signals", 0),
        escalations=collab.get("escalations", 0),
        revises=collab.get("revises", 0),
        duration_ms=duration_ms,
        error=result.get("error"),
        **phase0,
        **extra,
    )
