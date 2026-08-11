"""Contract-retry / decision-ladder helpers for AGENT-node execution.

Split from ``.node`` — pure move. Public ``should_skip_contract_retry_for_budget``
and existing test imports stay re-exported from ``.node``.
"""

from __future__ import annotations

from typing import Any

from agentcore.config import settings
from agentcore.runtime.runs.constants import HANDOFF_TOOL_NAME
from agentcore.runtime.runs.contract import (
    ContractVerdict,
    is_format_repairable,
    is_zero_files_gap,
)
from agentcore.runtime.runs.executor.shared import _registry_without
from agentcore.runtime.runs.retrieval_budget import RETRIEVAL_TOOL_NAMES
from agentcore.runtime.runs.worker_budget import DIRECTED_SEARCH_TOOL_NAMES

# Light-repair allow-list: format backfill / handoff enrichment only — no re-investigation.
_LIGHT_REPAIR_TOOL_NAMES: frozenset[str] = frozenset(
    {
        HANDOFF_TOOL_NAME,
        "file_write",
        "file_append",
        "str_replace",
        "write_section",
        "file_read",
    }
)
_LIGHT_REPAIR_MAX_ROUNDS = 4


def _files_expected(deliverable: Any) -> bool:
    """True when this run's contract expects workspace landing.

    Only ``form=files`` and/or non-empty ``artifacts`` — legacy flags alone do not.
    """
    if deliverable is None:
        return False
    if getattr(deliverable, "form", None) == "files":
        return True
    return bool(getattr(deliverable, "artifacts", None))


def _retry_token_budget(*, ceiling: int, spent: int) -> int:
    """Remaining token budget for a correction pass (总预算约束).

    ``ceiling <= 0`` means the hard ceiling is disabled (pass through 0).
    When already at/over the ceiling, return 1 so the next react_loop hits the
    hard top immediately（二次触顶立即收口）instead of resetting to a fresh ceiling.
    """
    if ceiling <= 0:
        return 0
    remaining = ceiling - spent
    if remaining <= 0:
        return 1
    return remaining


def _wind_down_entered(
    *,
    cutoff_reasons: list[str],
    token_ceiling: int,
    tokens_spent: int,
) -> bool:
    """True when this run already entered token/timeout wind_down (or past soft reserve)."""
    if "token_budget" in cutoff_reasons or "worker_timeout" in cutoff_reasons:
        return True
    if token_ceiling <= 0:
        return False
    from agentcore.runtime.runs.cutoff import (
        DEFAULT_TOKEN_WIND_DOWN_RESERVE,
        should_enter_token_wind_down,
    )

    reserve = int(
        settings.engine_worker_token_wind_down_reserve or DEFAULT_TOKEN_WIND_DOWN_RESERVE
    )
    return should_enter_token_wind_down(tokens_spent, token_ceiling, reserve)


def should_skip_contract_retry_for_budget(
    *,
    handoff_ok: bool,
    wind_down_entered: bool,
) -> bool:
    """定案 B：handoff 已成功且预算收尾/将尽 → 跳过自动契约返工（防空转）。

    真缺口交给审校/CEO，不靠耗尽后再硬返工。硬顶短路见调用方的 ceiling 分支。
    """
    return bool(handoff_ok and wind_down_entered)


def _narrow_for_light_repair(
    worker_tools: Any,
    allowed_tools: list[str] | None,
) -> tuple[Any, list[str]]:
    """Strip investigation tools for a format-only light repair pass.

    Unrestricted (``None``) → explicit light-repair allow-list ∩ registry.
    Explicit lists are intersected with :data:`_LIGHT_REPAIR_TOOL_NAMES` (already
    includes persist writes). 真纯丙后不再有「名单缺写盘 → 补写」半成品。
    """
    withhold = tuple(
        sorted(
            RETRIEVAL_TOOL_NAMES
            | DIRECTED_SEARCH_TOOL_NAMES
            | frozenset({"file_list", "code_execute", "test_run", "terminal"})
        )
    )
    narrowed_registry = _registry_without(worker_tools, *withhold)
    if allowed_tools is None:
        # Unrestricted → explicit light-repair allow-list (intersect registry).
        present = {
            s.name
            for s in narrowed_registry.list_all()
            if s.name in _LIGHT_REPAIR_TOOL_NAMES
        }
        return narrowed_registry, sorted(present)
    narrowed_allowed = [t for t in allowed_tools if t in _LIGHT_REPAIR_TOOL_NAMES]
    if HANDOFF_TOOL_NAME not in narrowed_allowed:
        narrowed_allowed = [*narrowed_allowed, HANDOFF_TOOL_NAME]
    return narrowed_registry, narrowed_allowed


def _can_light_repair(
    *,
    verdict: ContractVerdict,
    handoff_ok: bool,
    light_repair_used: bool,
) -> bool:
    """Format / handoff-thin failures get one in-place light repair before full retry."""
    if light_repair_used:
        return False
    if verdict.ok and handoff_ok:
        return False
    # Zero-disk gaps use write pass (not format light repair / full investigation retry).
    if is_zero_files_gap(verdict):
        return False
    return not (not verdict.ok and not is_format_repairable(verdict))


def _can_write_pass(
    *,
    verdict: ContractVerdict,
    files_expected: bool,
    files_written: int,
    write_pass_used: bool,
) -> bool:
    """Files-expected + zero disk → one short write pass (not full contract.retry)."""
    if write_pass_used or not files_expected:
        return False
    if int(files_written or 0) > 0:
        return False
    return is_zero_files_gap(verdict)
