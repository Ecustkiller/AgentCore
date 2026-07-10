"""Sequential Split — 运行时压力检测 + 分裂评估（Phase 2）。

触发条件（任一满足 → 进入评估，非直接分裂）：
- ``current_step_count > budget.max_steps * 0.6``
- ``token_consumed > budget.max_tokens * 0.7``
- ``tool_failure_count > 2``

评估默认用确定性启发式（可测、零额外 LLM 成本）；调用方可注入
``assess_fn`` 换成窄任务 LLM，只要仍产出 :class:`SplitDecision`。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.text import clip_preview
from agentcore.runtime.routing.models import (
    SplitBudget,
    SplitDecision,
    SplitPressure,
    SplitTrigger,
    SubTaskSpec,
)

logger = get_logger(__name__)

STEP_PRESSURE_RATIO = 0.6
TOKEN_PRESSURE_RATIO = 0.7
TOOL_FAILURE_THRESHOLD = 2

# 剩余预算中留给父 Worker 收尾的比例；其余按子任务均分
_PARENT_RESERVE_RATIO = 0.25
_MIN_SUBTASK_TOKENS = 500
_MAX_SUBTASKS = 4


def detect_split_pressure(
    *,
    current_step_count: int,
    token_consumed: int,
    tool_failure_count: int,
    budget: SplitBudget,
) -> SplitPressure:
    """Deterministic pressure check after a tool round (post Escalation Gate)."""
    triggers: list[SplitTrigger] = []
    if budget.max_steps > 0 and current_step_count > budget.max_steps * STEP_PRESSURE_RATIO:
        triggers.append(SplitTrigger.STEPS)
    if budget.max_tokens > 0 and token_consumed > budget.max_tokens * TOKEN_PRESSURE_RATIO:
        triggers.append(SplitTrigger.TOKENS)
    if tool_failure_count > TOOL_FAILURE_THRESHOLD:
        triggers.append(SplitTrigger.TOOL_FAILURES)

    pressure = SplitPressure(
        current_step_count=max(0, current_step_count),
        token_consumed=max(0, token_consumed),
        tool_failure_count=max(0, tool_failure_count),
        budget=budget,
        triggers=triggers,
    )
    if pressure.is_pressured:
        logger.info(
            "routing.split.pressure",
            triggers=[t.value for t in triggers],
            steps=pressure.current_step_count,
            max_steps=budget.max_steps,
            tokens=pressure.token_consumed,
            max_tokens=budget.max_tokens,
            tool_failures=pressure.tool_failure_count,
        )
    return pressure


def assess_split(
    *,
    pressure: SplitPressure,
    task: str,
    parent_progress_summary: str = "",
    remaining_token_budget: int | None = None,
    can_split: bool = True,
    assess_fn: Callable[..., SplitDecision] | None = None,
) -> SplitDecision:
    """Decide whether to split and into which ordered subtasks.

    ``can_split=False`` (Sub-Worker depth limit) always returns no-split.
    ``assess_fn`` when provided replaces the heuristic (e.g. LLM assessor).
    """
    if not can_split:
        return SplitDecision(
            should_split=False,
            rationale="can_split=False (depth limit); Sub-Worker cannot split further",
            triggers=list(pressure.triggers),
        )
    if not pressure.is_pressured:
        return SplitDecision(
            should_split=False,
            rationale="no pressure triggers",
            triggers=[],
        )

    remaining = (
        remaining_token_budget
        if remaining_token_budget is not None
        else max(0, pressure.budget.max_tokens - pressure.token_consumed)
    )

    if assess_fn is not None:
        decision = assess_fn(
            pressure=pressure,
            task=task,
            parent_progress_summary=parent_progress_summary,
            remaining_token_budget=remaining,
        )
        if not isinstance(decision, SplitDecision):
            raise TypeError("assess_fn must return SplitDecision")
        # Depth / budget safety: never let an assessor invent split when can_split
        # was already gated above; clamp empty subtasks → no-split.
        if decision.should_split and not decision.subtasks:
            decision = decision.model_copy(
                update={"should_split": False, "rationale": decision.rationale or "empty subtasks"}
            )
        logger.info(
            "routing.split.assess",
            should_split=decision.should_split,
            subtask_count=len(decision.subtasks),
            via="assess_fn",
            triggers=[t.value for t in decision.triggers or pressure.triggers],
        )
        return decision

    decision = _heuristic_assess(
        pressure=pressure,
        task=task,
        parent_progress_summary=parent_progress_summary,
        remaining_token_budget=remaining,
    )
    logger.info(
        "routing.split.assess",
        should_split=decision.should_split,
        subtask_count=len(decision.subtasks),
        via="heuristic",
        triggers=[t.value for t in decision.triggers],
        rationale=clip_preview(decision.rationale, 120),
    )
    return decision


def allocate_subtask_budgets(
    *,
    remaining_token_budget: int,
    subtask_count: int,
    parent_reserve_ratio: float = _PARENT_RESERVE_RATIO,
) -> list[int]:
    """Split remaining tokens: reserve a slice for the parent, equal-share the rest."""
    if subtask_count <= 0:
        return []
    remaining = max(0, remaining_token_budget)
    reserve = int(remaining * parent_reserve_ratio)
    pool = max(0, remaining - reserve)
    if pool <= 0:
        # Still give each subtask a tiny floor so the brief is well-formed;
        # parent may already be over budget.
        return [_MIN_SUBTASK_TOKENS] * subtask_count
    base = max(_MIN_SUBTASK_TOKENS, pool // subtask_count)
    budgets = [base] * subtask_count
    # Distribute leftover to the first tasks
    leftover = pool - base * subtask_count
    idx = 0
    while leftover > 0 and idx < subtask_count:
        budgets[idx] += 1
        leftover -= 1
        idx += 1
    return budgets


def summarize_parent_progress(
    *,
    rounds_completed: int,
    tool_names: Sequence[str] | None = None,
    content_preview: str = "",
    notes: str = "",
) -> str:
    """Build a short parent-progress summary for Sub-Worker context."""
    parts: list[str] = [f"已完成约 {rounds_completed} 轮工具/推理。"]
    names = [n for n in (tool_names or []) if n]
    if names:
        # de-dupe preserving order
        seen: set[str] = set()
        ordered: list[str] = []
        for n in names:
            if n not in seen:
                seen.add(n)
                ordered.append(n)
        parts.append("用过的工具: " + ", ".join(ordered[:12]))
    preview = (content_preview or "").strip()
    if preview:
        parts.append("当前草稿摘要: " + clip_preview(preview, 240))
    extra = (notes or "").strip()
    if extra:
        parts.append(extra)
    return " ".join(parts)


def _heuristic_assess(
    *,
    pressure: SplitPressure,
    task: str,
    parent_progress_summary: str,
    remaining_token_budget: int,
) -> SplitDecision:
    """Deterministic split plan from pressure + task text.

    Conservative: only split when pressure is real AND remaining budget can fund
    at least one meaningful Sub-Worker. Tool-failure-only pressure prefers a
    single "换策略" subtask; step/token pressure prefers 2 ordered slices.
    """
    triggers = list(pressure.triggers)
    if remaining_token_budget < _MIN_SUBTASK_TOKENS:
        return SplitDecision(
            should_split=False,
            rationale=f"remaining budget {remaining_token_budget} too small to fund Sub-Worker",
            triggers=triggers,
        )

    task_text = (task or "").strip() or "（未命名任务）"
    progress = (parent_progress_summary or "").strip()

    if SplitTrigger.TOOL_FAILURES in triggers and len(triggers) == 1:
        goals = [
            f"换策略完成剩余工作：绕开反复失败的路径，推进「{clip_preview(task_text, 80)}」",
        ]
        rationale = "tool_failure_count exceeded threshold; single strategy-change subtask"
    elif SplitTrigger.STEPS in triggers or SplitTrigger.TOKENS in triggers:
        goals = [
            f"完成前半：推进「{clip_preview(task_text, 80)}」中可独立交付的部分",
            f"完成收尾：整合前半产出并交付「{clip_preview(task_text, 80)}」的剩余目标",
        ]
        rationale = "step/token pressure; sequential two-phase split"
    else:
        goals = [f"继续推进并交付：「{clip_preview(task_text, 80)}」"]
        rationale = "pressure triggered; single continuation subtask"

    goals = goals[:_MAX_SUBTASKS]
    budgets = allocate_subtask_budgets(
        remaining_token_budget=remaining_token_budget,
        subtask_count=len(goals),
    )
    constraints = [
        "不可再分裂子任务（深度硬限）",
        "复用父 Worker 已完成工作，避免重复",
        "完成后回报结果摘要、产出物引用与副作用",
    ]
    subtasks = [
        SubTaskSpec(
            goal=goal,
            constraints=list(constraints),
            context_summary=progress,
            token_budget=budgets[i],
        )
        for i, goal in enumerate(goals)
    ]
    return SplitDecision(
        should_split=True,
        rationale=rationale,
        subtasks=subtasks,
        triggers=triggers,
    )


def total_tool_failures(failure_counts: dict[str, int] | Any) -> int:
    """Sum per-tool failure tallies (LoopController._tool_failures or mapping)."""
    if failure_counts is None:
        return 0
    if hasattr(failure_counts, "values") and not isinstance(failure_counts, type):
        try:
            return int(sum(int(v) for v in failure_counts.values()))
        except (TypeError, ValueError):
            return 0
    return 0
