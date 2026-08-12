"""Shared「this model works on this provider」check.

Used by BYOK connectivity test and model-profile save warnings. Prefer
``list_models``; fall through to ``probe`` when the list is empty, missing, or
omits the model (e.g. Ark ``ep-`` endpoints). Save path uses a softer policy so
list fetch failures never block or slow a successful save.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from agentcore.core.errors import LLMAuthError, LLMError, LLMInsufficientBalanceError

Reachability = Literal["ok", "error", "unknown"]
ListKind = Literal["ok", "hard_error", "soft_error"]


@dataclass(frozen=True)
class ModelListOutcome:
    """One ``GET /models`` attempt — reuse across several model checks."""

    kind: ListKind
    model_ids: tuple[str, ...] = ()
    message: str | None = None


@dataclass(frozen=True)
class CheckPolicy:
    """How inconclusive / list-hard outcomes map to reachability.

    ``not_in_list`` always probes when the upstream list is non-empty and omits
    the model — that is what separates Ark ``ep-`` (probe OK) from typos
    (probe fail). Soft / empty / hard list outcomes differ by caller:
    connectivity test probes or errors; save warns only when a definitive
    list-miss + probe fail is available.
    """

    on_list_hard_error: Literal["error", "unknown"] = "error"
    on_list_soft_or_empty: Literal["probe", "unknown"] = "probe"


CONNECTIVITY_POLICY = CheckPolicy()
SAVE_WARN_POLICY = CheckPolicy(
    on_list_hard_error="unknown",
    on_list_soft_or_empty="unknown",
)


async def fetch_model_list(provider: object) -> ModelListOutcome:
    """Best-effort ``list_models``; auth/balance → hard_error, other LLM → soft."""
    list_fn = getattr(provider, "list_models", None)
    if not callable(list_fn):
        return ModelListOutcome(kind="soft_error")
    try:
        model_ids = await list_fn()
    except (LLMAuthError, LLMInsufficientBalanceError) as e:
        return ModelListOutcome(kind="hard_error", message=str(e))
    except LLMError:
        return ModelListOutcome(kind="soft_error")
    return ModelListOutcome(kind="ok", model_ids=tuple(model_ids or ()))


async def check_model_reachable(
    provider: object,
    *,
    model: str,
    model_list: ModelListOutcome | None = None,
    policy: CheckPolicy = CONNECTIVITY_POLICY,
) -> tuple[Reachability, str | None]:
    """Return whether ``model`` is usable on ``provider`` under ``policy``.

    Prefers a successful non-empty list that contains ``model``. Otherwise
    probes chat when the policy allows (same ladder as the former
    ``_run_connectivity_test`` body).
    """
    outcome = model_list if model_list is not None else await fetch_model_list(provider)
    model_s = (model or "").strip()

    if outcome.kind == "hard_error":
        if policy.on_list_hard_error == "error":
            return "error", outcome.message
        return "unknown", None

    if outcome.kind == "ok" and outcome.model_ids and model_s in outcome.model_ids:
        return "ok", None

    # Soft list failure, empty list, or non-empty list missing model.
    list_inconclusive = outcome.kind == "soft_error" or (
        outcome.kind == "ok" and not outcome.model_ids
    )
    if list_inconclusive and policy.on_list_soft_or_empty == "unknown":
        return "unknown", None

    if not model_s:
        return "error", "模型名称不能为空"

    try:
        await provider.probe(model=model_s)  # type: ignore[attr-defined]
    except LLMError as e:
        return "error", str(e)
    return "ok", None
