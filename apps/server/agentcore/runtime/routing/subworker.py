"""Sub-Worker lifecycle — create, run (sequential), fold results (Phase 2).

Sub-Worker reuses ``react_loop`` with ``can_split=False`` (depth hard limit = 1).
Phase 2 only supports sequential execution: one Sub-Worker finishes before the next starts.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.text import clip_preview
from dataclasses import replace

from agentcore.llm.profiles import ProfileParams, get_profile
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import EventSink
from agentcore.runtime.routing.models import (
    SplitDecision,
    SubTaskSpec,
    SubWorkerBrief,
    SubWorkerResult,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

# Sub-Worker profile: reuse parent model; cap rounds tighter than a full worker.
_DEFAULT_SUBWORKER_MAX_ROUNDS = 8

_ARTIFACT_PATH_RE = re.compile(
    r"(?:^|\s)((?:[\w.-]+/)*[\w.-]+\.(?:py|ts|tsx|js|jsx|md|json|yml|yaml|toml|txt|css|html))\b"
)
_SIDE_EFFECT_HINTS = (
    "写入",
    "修改",
    "删除",
    "创建",
    "更新了",
    "wrote",
    "modified",
    "created",
    "deleted",
    "updated",
)


def new_subworker_id() -> str:
    return f"sw_{uuid.uuid4().hex[:12]}"


def build_subworker_brief(
    *,
    spec: SubTaskSpec,
    parent_run_id: str = "",
    parent_agent_id: str = "",
    parent_progress_summary: str = "",
    subworker_id: str | None = None,
) -> SubWorkerBrief:
    """Create a depth-limited Sub-Worker brief from a split subtask."""
    return SubWorkerBrief(
        subworker_id=subworker_id or new_subworker_id(),
        parent_run_id=parent_run_id,
        parent_agent_id=parent_agent_id,
        goal=spec.goal,
        constraints=list(spec.constraints),
        parent_progress_summary=parent_progress_summary or spec.context_summary,
        context_summary=spec.context_summary,
        token_budget=spec.token_budget,
        can_split=False,
        depth=1,
    )


def briefs_from_decision(
    *,
    decision: SplitDecision,
    parent_run_id: str = "",
    parent_agent_id: str = "",
    parent_progress_summary: str = "",
) -> list[SubWorkerBrief]:
    """Materialize ordered Sub-Worker briefs from a split decision."""
    if not decision.should_split:
        return []
    return [
        build_subworker_brief(
            spec=spec,
            parent_run_id=parent_run_id,
            parent_agent_id=parent_agent_id,
            parent_progress_summary=parent_progress_summary,
        )
        for spec in decision.subtasks
    ]


def extract_result_from_content(
    *,
    subworker_id: str,
    content: str,
    usage: TokenUsage | None = None,
    rounds: int = 0,
    success: bool = True,
    failure: str = "",
) -> SubWorkerResult:
    """Parse Sub-Worker final text into a structured upward report."""
    text = (content or "").strip()
    artifacts = _extract_artifact_refs(text)
    side_effects = _extract_side_effects(text)
    summary = clip_preview(text, 400) if text else ""
    tokens = int(usage.total_tokens) if usage is not None else 0
    ok = success and not failure
    return SubWorkerResult(
        subworker_id=subworker_id,
        success=ok,
        summary=summary,
        artifact_refs=artifacts,
        failure=failure if not ok else "",
        side_effects=side_effects,
        tokens_used=tokens,
        rounds=max(0, rounds),
    )


def fold_results_for_parent(results: Sequence[SubWorkerResult]) -> str:
    """Fold Sub-Worker results into one parent-journal / message injection block."""
    if not results:
        return ""
    lines = ["[Sub-Worker 顺序分裂结果]"]
    for i, r in enumerate(results, start=1):
        lines.append(f"{i}. {r.subworker_id}: {r.to_fold_summary()}")
    return "\n".join(lines)


def aggregate_results(results: Sequence[SubWorkerResult]) -> dict[str, Any]:
    """Summary dict for events / RunState (all sequential Sub-Workers)."""
    return {
        "count": len(results),
        "success_count": sum(1 for r in results if r.success),
        "failure_count": sum(1 for r in results if not r.success),
        "tokens_used": sum(r.tokens_used for r in results),
        "rounds": sum(r.rounds for r in results),
        "results": [r.to_event_payload() for r in results],
        "fold_summary": fold_results_for_parent(results),
    }


async def run_subworker(
    *,
    brief: SubWorkerBrief,
    llm: OpenAICompatibleProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_context: ToolContext,
    turn_model: str,
    allowed_tool_names: list[str] | None = None,
    profile: ProfileParams | None = None,
    approval_gate: ApprovalGate | None = None,
    on_content: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
) -> SubWorkerResult:
    """Execute one Sub-Worker via ``react_loop`` with ``can_split=False``.

    Uses the same model as the parent (``turn_model``). Depth limit is enforced by
    passing ``can_split=False`` into the loop's split context — Sub-Workers never
    re-enter sequential splitting.
    """
    if brief.can_split:
        # Defensive: briefs must always be depth-limited in Phase 2.
        brief = brief.model_copy(update={"can_split": False, "depth": 1})

    sub_profile = profile or get_profile("agent.fast")
    # Cap rounds for Sub-Worker; never exceed parent profile if one was passed.
    max_rounds = min(sub_profile.max_rounds, _DEFAULT_SUBWORKER_MAX_ROUNDS)
    if max_rounds != sub_profile.max_rounds:
        sub_profile = replace(sub_profile, max_rounds=max_rounds)

    messages = [LLMMessage(role="user", content=brief.to_user_message())]
    logger.info(
        "routing.subworker.start",
        subworker_id=brief.subworker_id,
        parent_run_id=brief.parent_run_id,
        token_budget=brief.token_budget,
        can_split=brief.can_split,
        depth=brief.depth,
    )

    # Lazy import: avoid routing ↔ engine circular import at module load.
    from agentcore.runtime.engine import react_loop

    try:
        content, _reasoning, usage, rounds = await react_loop(
            messages=messages,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_context=tool_context,
            profile=sub_profile,
            turn_model=turn_model,
            allowed_tool_names=allowed_tool_names,
            on_content=on_content,
            on_reasoning=on_reasoning,
            raise_on_error=True,
            annotate_citations=False,
            approval_gate=approval_gate,
            run_id=brief.parent_run_id,
            role="worker",
            deliverable_only=True,
            # Sub-Worker: no Escalation Gate sink merge into parent (parent already gated);
            # split disabled via split_context below.
            gate_escalation_sink=None,
            split_context=_split_context_for_subworker(brief),
        )
    except Exception as exc:
        logger.warning(
            "routing.subworker.failed",
            subworker_id=brief.subworker_id,
            error=type(exc).__name__,
            detail=clip_preview(str(exc), 200),
        )
        return SubWorkerResult(
            subworker_id=brief.subworker_id,
            success=False,
            summary="",
            failure=clip_preview(f"{type(exc).__name__}: {exc}", 300),
            tokens_used=0,
            rounds=0,
        )

    result = extract_result_from_content(
        subworker_id=brief.subworker_id,
        content=content,
        usage=usage,
        rounds=rounds,
        success=True,
    )
    logger.info(
        "routing.subworker.done",
        subworker_id=brief.subworker_id,
        success=result.success,
        tokens_used=result.tokens_used,
        rounds=result.rounds,
    )
    return result


async def run_sequential_subworkers(
    *,
    briefs: Sequence[SubWorkerBrief],
    llm: OpenAICompatibleProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_context: ToolContext,
    turn_model: str,
    allowed_tool_names: list[str] | None = None,
    profile: ProfileParams | None = None,
    approval_gate: ApprovalGate | None = None,
    on_content: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
    on_started: Callable[[SubWorkerBrief], None] | None = None,
    on_completed: Callable[[SubWorkerBrief, SubWorkerResult], None] | None = None,
    runner: Callable[..., Awaitable[SubWorkerResult]] | None = None,
) -> list[SubWorkerResult]:
    """Run Sub-Workers one after another (Phase 2 sequential only)."""
    results: list[SubWorkerResult] = []
    execute = runner or run_subworker
    for brief in briefs:
        if on_started is not None:
            on_started(brief)
        result = await execute(
            brief=brief,
            llm=llm,
            tools=tools,
            sink=sink,
            tool_context=tool_context,
            turn_model=turn_model,
            allowed_tool_names=allowed_tool_names,
            profile=profile,
            approval_gate=approval_gate,
            on_content=on_content,
            on_reasoning=on_reasoning,
        )
        results.append(result)
        if on_completed is not None:
            on_completed(brief, result)
    return results


async def apply_sequential_split_after_tools(
    *,
    split_context: dict[str, Any],
    current_step_count: int,
    token_consumed: int,
    tool_failure_count: int,
    tool_names: Sequence[str],
    content_preview: str,
    llm: OpenAICompatibleProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_context: ToolContext,
    turn_model: str,
    allowed_tool_names: list[str] | None = None,
    profile: ProfileParams | None = None,
    approval_gate: ApprovalGate | None = None,
    on_content: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
) -> tuple[str | None, list[SubWorkerResult]]:
    """Post-gate sequential split hook for ``react_loop``.

    Returns ``(fold_message_or_none, results)``. When a split runs, the fold message
    should be appended as a user turn so the parent Worker continues with Sub-Worker
    outcomes in context. No-ops when ``can_split`` is False, already split, or
    pressure/assessment declines.
    """
    from agentcore.runtime.events import (
        run_split_assessed,
        run_subworker_completed,
        run_subworker_started,
    )
    from agentcore.runtime.routing.models import SplitBudget
    from agentcore.runtime.routing.split import (
        assess_split,
        detect_split_pressure,
        summarize_parent_progress,
    )

    if not split_context.get("can_split", True):
        return None, []
    if split_context.get("already_split"):
        return None, []

    max_steps = int(split_context.get("max_steps") or (profile.max_rounds if profile else 16))
    max_tokens = int(split_context.get("token_budget") or 0)
    budget = SplitBudget(max_steps=max(1, max_steps), max_tokens=max(0, max_tokens))
    pressure = detect_split_pressure(
        current_step_count=current_step_count,
        token_consumed=token_consumed,
        tool_failure_count=tool_failure_count,
        budget=budget,
    )
    if not pressure.is_pressured:
        return None, []

    task = str(split_context.get("task") or "")
    parent_progress = str(split_context.get("parent_progress_summary") or "")
    if not parent_progress:
        parent_progress = summarize_parent_progress(
            rounds_completed=current_step_count,
            tool_names=tool_names,
            content_preview=content_preview,
        )

    remaining = max(0, max_tokens - token_consumed)
    assess_fn = split_context.get("assess_fn")
    decision = assess_split(
        pressure=pressure,
        task=task,
        parent_progress_summary=parent_progress,
        remaining_token_budget=remaining,
        can_split=True,
        assess_fn=assess_fn if callable(assess_fn) else None,
    )

    run_id = str(split_context.get("run_id") or getattr(tool_context, "run_id", "") or "")
    agent_id = str(split_context.get("agent_id") or getattr(tool_context, "agent_id", "") or "")
    sink.emit(
        run_split_assessed(
            run_id,
            agent_id,
            should_split=decision.should_split,
            rationale=decision.rationale,
            triggers=[t.value for t in decision.triggers],
            subtasks=[
                {
                    "goal": s.goal,
                    "constraints": list(s.constraints),
                    "context_summary": s.context_summary,
                    "token_budget": s.token_budget,
                }
                for s in decision.subtasks
            ],
            pressure=pressure.to_event_payload(),
        )
    )

    if not decision.should_split:
        return None, []

    briefs = briefs_from_decision(
        decision=decision,
        parent_run_id=run_id,
        parent_agent_id=agent_id,
        parent_progress_summary=parent_progress,
    )
    if not briefs:
        return None, []

    split_context["already_split"] = True
    total = len(briefs)

    def _on_started(brief: SubWorkerBrief) -> None:
        idx = next(
            (i for i, b in enumerate(briefs) if b.subworker_id == brief.subworker_id),
            0,
        )
        sink.emit(
            run_subworker_started(
                run_id,
                agent_id,
                subworker_id=brief.subworker_id,
                goal=brief.goal,
                token_budget=brief.token_budget,
                index=idx,
                total=total,
                can_split=brief.can_split,
                depth=brief.depth,
            )
        )

    def _on_completed(brief: SubWorkerBrief, result: SubWorkerResult) -> None:
        idx = next(
            (i for i, b in enumerate(briefs) if b.subworker_id == brief.subworker_id),
            0,
        )
        sink.emit(
            run_subworker_completed(
                run_id,
                agent_id,
                subworker_id=result.subworker_id,
                success=result.success,
                summary=result.summary,
                artifact_refs=result.artifact_refs,
                failure=result.failure,
                side_effects=result.side_effects,
                tokens_used=result.tokens_used,
                rounds=result.rounds,
                index=idx,
                total=total,
                fold_summary=result.to_fold_summary(),
            )
        )

    results = await run_sequential_subworkers(
        briefs=briefs,
        llm=llm,
        tools=tools,
        sink=sink,
        tool_context=tool_context,
        turn_model=turn_model,
        allowed_tool_names=allowed_tool_names,
        profile=profile,
        approval_gate=approval_gate,
        on_content=on_content,
        on_reasoning=on_reasoning,
        on_started=_on_started,
        on_completed=_on_completed,
    )
    fold = fold_results_for_parent(results)
    logger.info(
        "routing.split.applied",
        run_id=run_id,
        subworker_count=len(results),
        success_count=sum(1 for r in results if r.success),
    )
    return fold, results


def _split_context_for_subworker(brief: SubWorkerBrief) -> dict[str, Any]:
    """Loop-facing split knobs: Sub-Worker must not re-split."""
    return {
        "can_split": False,
        "token_budget": brief.token_budget,
        "task": brief.goal,
        "parent_progress_summary": brief.parent_progress_summary,
        "depth": brief.depth,
        "subworker_id": brief.subworker_id,
    }


def _extract_artifact_refs(text: str) -> list[str]:
    found = _ARTIFACT_PATH_RE.findall(text)
    seen: set[str] = set()
    out: list[str] = []
    for path in found:
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out[:20]


def _extract_side_effects(text: str) -> list[str]:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    hits = [
        ln for ln in lines if any(h in ln.lower() or h in ln for h in _SIDE_EFFECT_HINTS)
    ]
    return hits[:10]
