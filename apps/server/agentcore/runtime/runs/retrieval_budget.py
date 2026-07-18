"""Plan-time retrieval budget (检索与交付约束前置提案 A1).

Structured defaults on ``RunSpec.retrieval_budget`` + strip search tools when the
resolved limit is 0. Runtime counter lives on ``ToolContext.retrieval_budget``
(:class:`~agentcore.tools.protocol.RetrievalBudgetState`); enforce in
``tool_exec`` (orthogonal to LoopController / team_gate). Cache hits and A3
query-contract rejects do not consume budget.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.tools.protocol import RetrievalBudgetState

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec
    from agentcore.tools.protocol import ToolResult

__all__ = [
    "BUDGET_EXHAUSTED_FEEDBACK",
    "DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM",
    "DEFAULT_RETRIEVAL_BUDGET_ROOT",
    "RETRIEVAL_TOOL_NAMES",
    "RetrievalBudgetState",
    "apply_retrieval_budgets",
    "apply_retrieval_budgets_to_specs",
    "budget_exhausted_output",
    "charges_retrieval_budget",
    "default_retrieval_budget",
    "exclude_retrieval_tools",
    "format_retrieval_budget_line",
    "parse_retrieval_budget",
]

# Tools that share one per-run retrieval budget (web_search + read_url combined).
RETRIEVAL_TOOL_NAMES: frozenset[str] = frozenset({"web_search", "read_url"})

# Structured defaults — conservative starters; 待 A6 观测校准 (提案 §六).
DEFAULT_RETRIEVAL_BUDGET_ROOT = 8  # 无上游依赖（调研波）
DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM = 3  # 有上游且非 prose 合成波

BUDGET_EXHAUSTED_FEEDBACK = (
    "检索预算已尽：请基于证据台账中现有材料交付，并在交接（handoff）中如实标注检索缺口"
    "（缺什么、为何没补上）。不要再调用 web_search / read_url。"
    "主管可用 continue_from_run_id 带现场续派并显式提高 retrieval_budget。"
)


def parse_retrieval_budget(raw: Any) -> int | None:
    """CEO-explicit ``retrieval_budget``; ``None`` = omit → structured default later."""
    if raw is None or isinstance(raw, bool):
        return None
    if isinstance(raw, int) and raw >= 0:
        return raw
    if isinstance(raw, float) and raw >= 0 and raw == int(raw):
        return int(raw)
    return None


def default_retrieval_budget(spec: RunSpec) -> int:
    """Structured default from DAG shape + deliverable.form — never role strings."""
    has_upstream = bool(spec.depends_on)
    form = spec.deliverable.form if spec.deliverable is not None else None
    if not has_upstream:
        return DEFAULT_RETRIEVAL_BUDGET_ROOT
    if form == "prose":
        return 0
    return DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM


def exclude_retrieval_tools(
    tools: list[str] | None,
    valid_tools: set[str] | None,
) -> list[str] | None:
    """Remove web_search/read_url from an allow-list (预算 0 → 不装配检索工具).

    Unrestricted (``None``) becomes an explicit list of ``valid_tools`` minus
    retrieval tools when ``valid_tools`` is known. Returns ``[]`` (not ``None``)
    when the stripped set is empty — unlike builder._tools, empty here means
    "no tools from the declared set" so the engine does not re-open all tools;
    escalate / notes are re-granted later by the executor.
    """
    if tools is not None:
        return [t for t in tools if t not in RETRIEVAL_TOOL_NAMES]
    if valid_tools is not None:
        return sorted(valid_tools - RETRIEVAL_TOOL_NAMES)
    return None


def apply_retrieval_budgets(
    plan: RunPlan,
    *,
    valid_tools: set[str] | None = None,
) -> None:
    """Resolve budgets on every node (CEO explicit wins) and strip tools when 0."""
    for spec in plan.nodes:
        _apply_one(spec, valid_tools=valid_tools)


def apply_retrieval_budgets_to_specs(
    specs: list[RunSpec],
    *,
    valid_tools: set[str] | None = None,
) -> None:
    """Same as :func:`apply_retrieval_budgets` for a replan ``add`` batch."""
    for spec in specs:
        _apply_one(spec, valid_tools=valid_tools)


def _apply_one(spec: RunSpec, *, valid_tools: set[str] | None) -> None:
    if spec.retrieval_budget is None:
        spec.retrieval_budget = default_retrieval_budget(spec)
    if spec.retrieval_budget == 0:
        # 复用 tasks[].tools 白名单：预算 0 → 不装配检索工具。
        stripped = exclude_retrieval_tools(spec.tools, valid_tools)
        if stripped is not None:
            spec.tools = stripped


def format_retrieval_budget_line(budget: int | None) -> str:
    """Worker-facing one-liner for the deliverable / context block."""
    if budget is None:
        return ""
    if budget <= 0:
        return (
            "- 检索预算：0（本任务不装配 web_search / read_url；"
            "基于上游与台账现有证据交付，缺口在交接中标注）"
        )
    return (
        f"- 检索预算：本 run 合计最多 {budget} 次 web_search/read_url"
        "（缓存命中不计）；用尽后基于台账现有证据交付并在交接中标注检索缺口。"
        "续派请主管用 continue_from_run_id 并显式提高 retrieval_budget"
    )


def charges_retrieval_budget(result: ToolResult) -> bool:
    """True when a completed retrieval call should consume one budget slot.

    Cache hits (``metadata.cached``) do not charge. Failures (including A3 query
    contract rejects) do not charge — they never produced a live backend hit worth
    counting, and A3 must remain free to rewrite (提案 A3).
    """
    if not result.success:
        return False
    meta = result.metadata or {}
    return not meta.get("cached")


def budget_exhausted_output() -> str:
    return BUDGET_EXHAUSTED_FEEDBACK
