"""SSE event type definitions and EventSink.

Events flow from the engine → asyncio.Queue → SSE StreamingResponse → client.
The EventSink decouples execution from delivery (backpressure-safe).
"""

import asyncio
import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    MESSAGE_START = "message_start"
    CONTENT_DELTA = "content_delta"
    REASONING_DELTA = "reasoning_delta"
    TOOL_USE_START = "tool_use_start"
    TOOL_USE_END = "tool_use_end"
    MESSAGE_END = "message_end"
    ERROR = "error"
    TITLE_GENERATED = "title_generated"
    TURN_SAVED = "turn_saved"
    # Multi-agent execution events
    RUN_PLAN = "run_plan"
    PLAN_REVIEW_REQUIRED = "plan_review_required"
    PLAN_REVIEW_RESOLVED = "plan_review_resolved"
    RUN_STARTED = "run_started"
    RUN_OUTPUT_DELTA = "run_output_delta"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_PROGRESS = "run_progress"
    CHECKPOINT_REVIEW = "checkpoint_review"
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_RESOLVED = "approval_resolved"


class FinishReason(StrEnum):
    END_TURN = "end_turn"
    MAX_ROUNDS = "max_rounds"
    DEGRADED = "degraded"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class SSEEvent:
    """A single event to be sent over the SSE stream."""

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def message_start(message_id: str, *, conversation_id: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.MESSAGE_START,
        payload={"message_id": message_id, "conversation_id": conversation_id},
    )


def content_delta(delta: str) -> SSEEvent:
    return SSEEvent(type=EventType.CONTENT_DELTA, payload={"delta": delta})


def reasoning_delta(delta: str) -> SSEEvent:
    return SSEEvent(type=EventType.REASONING_DELTA, payload={"delta": delta})


def tool_use_start(tool_call_id: str, tool_name: str, arguments: dict[str, Any]) -> SSEEvent:
    return SSEEvent(
        type=EventType.TOOL_USE_START,
        payload={
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def tool_use_end(tool_call_id: str, tool_name: str, *, success: bool, output: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.TOOL_USE_END,
        payload={
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "status": "success" if success else "error",
            "result": output,
        },
    )


def message_end(
    finish_reason: FinishReason,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    rounds: int = 0,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.MESSAGE_END,
        payload={
            "finish_reason": finish_reason,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "reasoning_tokens": reasoning_tokens,
            },
            "rounds": rounds,
        },
    )


def error_event(code: str, message: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.ERROR,
        payload={"code": code, "message": message},
    )


def title_generated(title: str, *, conversation_id: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.TITLE_GENERATED,
        payload={"conversation_id": conversation_id, "title": title},
    )


def turn_saved(*, user_message_id: str) -> SSEEvent:
    """Authoritative id of the just-persisted user message.

    Emitted right after the user turn is written, before the model runs. Lets the
    client swap its optimistic (client-UUID) bubble for the real row id, so
    regenerate / edit target the correct row in-session — and so a retry after a
    mid-stream failure regenerates from the saved turn instead of resending it
    (which would duplicate the user message). Only the user id is needed: every
    in-session action re-runs *from* the user message.
    """
    return SSEEvent(
        type=EventType.TURN_SAVED,
        payload={"user_message_id": user_message_id},
    )


def run_plan(
    *,
    execution_id: str,
    plan_type: str,
    task_summary: str,
    agents: list[dict[str, Any]],
    steps: list[dict[str, Any]],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_PLAN,
        payload={
            "execution_id": execution_id,
            "plan_type": plan_type,
            "task_summary": task_summary,
            "agents": agents,
            "steps": steps,
        },
    )


def plan_review_required(
    *,
    review_id: str,
    execution_id: str,
    agents: list[dict[str, Any]],
) -> SSEEvent:
    """Pre-execution gate: the team is planned but not yet running.

    The client shows a "team preview" where the user can override each agent's
    model tier and reasoning depth, then resolves this interaction with action
    "start" (carrying the chosen per-agent overrides) or "cancel". ``agents``
    echoes the planned roster with each agent's tier plus its effective
    thinking/reasoning_effort so the client can seed the editor.
    """
    return SSEEvent(
        type=EventType.PLAN_REVIEW_REQUIRED,
        payload={
            "review_id": review_id,
            "execution_id": execution_id,
            "agents": agents,
        },
    )


def plan_review_resolved(review_id: str, action: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.PLAN_REVIEW_RESOLVED,
        payload={"review_id": review_id, "action": action},
    )


def run_started(run_id: str, agent_id: str, step_id: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_STARTED,
        payload={"run_id": run_id, "agent_id": agent_id, "step_id": step_id},
    )


def run_output_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_OUTPUT_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_completed(run_id: str, agent_id: str, *, output_summary: str, duration_ms: int) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_COMPLETED,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "output_summary": output_summary,
            "duration_ms": duration_ms,
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


def checkpoint_review(
    *,
    checkpoint_id: str,
    after_step: str,
    decision: str,
    reason: str,
    summary: str,
) -> SSEEvent:
    """Orchestrator's verdict at a checkpoint: continue / adjust / escalate.

    Emitted before any user prompt. Only `escalate` is followed by an
    `approval_required` (the user decides); `continue` / `adjust` proceed
    automatically. `reason` is the orchestrator's rationale (shown to the user).
    """
    return SSEEvent(
        type=EventType.CHECKPOINT_REVIEW,
        payload={
            "checkpoint_id": checkpoint_id,
            "after_step": after_step,
            "decision": decision,
            "reason": reason,
            "summary": summary,
        },
    )


def approval_required(
    *,
    checkpoint_id: str,
    after_step: str,
    summary: str,
    reason: str,
    actions: list[str],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.APPROVAL_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "after_step": after_step,
            "summary": summary,
            "reason": reason,
            "actions": actions,
        },
    )


def approval_resolved(checkpoint_id: str, action: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.APPROVAL_RESOLVED,
        payload={"checkpoint_id": checkpoint_id, "action": action},
    )


class EventSink:
    """Async queue bridging execution (producer) and SSE (consumer).

    Lifecycle events are guaranteed delivery; content deltas can be dropped
    under backpressure (not implemented yet — unbounded queue for MVP).
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._closed = False

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            self._queue.put_nowait(event)

    def close(self) -> None:
        """Signal end-of-stream to consumer."""
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def __aiter__(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
