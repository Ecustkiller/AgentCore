"""Multi-agent run and debate SSE event factories."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.types import EventType, SSEEvent


def run_plan(
    *,
    execution_id: str,
    plan_type: str,
    task_summary: str,
    agents: list[dict[str, Any]],
    runs: list[dict[str, Any]],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PLAN,
        payload={
            "execution_id": execution_id,
            "plan_type": plan_type,
            "task_summary": task_summary,
            "agents": agents,
            "runs": runs,
        },
    )


def plan_revised(
    *,
    execution_id: str,
    revisions: list[dict[str, Any]],
) -> SSEEvent:
    """The CEO autonomously adjusted a paused plan via ``replan`` (受监督的波循环). Carries
    the affected run_ids + per-node ``kind`` (``bind`` = a late-bound placeholder finalised
    from upstream evidence; ``steer`` = a not-yet-run node re-steered after a scope deviation)
    so every end folds a non-interrupting「计划已调整」trace onto those graph nodes (设计 §7.2
    「计划已调整」轻痕迹). Emitted only when something actually changed (a no-op resume sends
    nothing); journaled, so the trace replays on reload."""
    return SSEEvent(
        type=EventType.PLAN_REVISED,
        payload={
            "execution_id": execution_id,
            "revisions": revisions,
        },
    )


def run_started(
    run_id: str,
    agent_id: str,
    *,
    parent_run_id: str | None = None,
    kind: str = "agent",
    revision: int = 0,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_STARTED,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "parent_run_id": parent_run_id,
            "kind": kind,
            "revision": revision,
        },
    )


def run_context(run_id: str, agent_id: str, blocks: list[dict[str, Any]]) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_CONTEXT,
        payload={"run_id": run_id, "agent_id": agent_id, "blocks": blocks},
    )


def run_output_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_OUTPUT_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_reasoning_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_REASONING_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_tool_progress(
    run_id: str, agent_id: str, tool_name: str, chars: int
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_TOOL_PROGRESS,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "tool_name": tool_name,
            "chars": chars,
        },
    )


def escalation_raised(
    run_id: str,
    agent_id: str,
    *,
    question: str,
    assumption: str,
    blocking: bool,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_ESCALATION,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "question": question,
            "assumption": assumption,
            "blocking": blocking,
        },
    )


def run_completed(
    run_id: str,
    agent_id: str,
    *,
    output_summary: str,
    duration_ms: int,
    role: str = "member",
    model: str = "",
    usage: dict[str, int] | None = None,
    cost: dict[str, Any] | None = None,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_COMPLETED,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "output_summary": output_summary,
            "duration_ms": duration_ms,
            "role": role,
            "model": model,
            "usage": usage
            if usage is not None
            else {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0},
            "cost": cost
            if cost is not None
            else {"input": 0, "cached": 0, "output": 0, "total": 0, "currency": "USD"},
        },
    )


def run_failed(run_id: str, agent_id: str, error: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_FAILED,
        payload={"run_id": run_id, "agent_id": agent_id, "error": error},
    )


def run_progress(completed: int, total: int) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PROGRESS,
        payload={"completed": completed, "total": total},
    )


def debate_result(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_RESULT,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )


def debate_round_started(
    *,
    execution_id: str,
    moderator_run_id: str,
    round_no: int,
    focus: str,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_ROUND_STARTED,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            "round_no": round_no,
            "focus": focus,
        },
    )


def debate_round(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_ROUND,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )
