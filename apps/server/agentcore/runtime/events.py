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
    CITATIONS = "citations"
    # Tool approval gate (CEO chat path): a GRANTABLE tool is paused awaiting the
    # user's decision, then resolved.
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_RESOLVED = "approval_resolved"
    # Local-workspace op channel (双模式工作区 P2): a server-side LocalWorkspace
    # asks the bound desktop client to run a file/exec op against the real local
    # directory, then awaits the result posted back to the ops resolve endpoint.
    # Transport only — deliberately NOT journaled into the team graph.
    WORKSPACE_OP_REQUIRED = "workspace_op_required"
    # Multi-agent execution events (CEO delegate path)
    RUN_PLAN = "run_plan"
    RUN_STARTED = "run_started"
    RUN_OUTPUT_DELTA = "run_output_delta"
    RUN_REASONING_DELTA = "run_reasoning_delta"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_PROGRESS = "run_progress"


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


def citations_event(citations: list[dict[str, Any]]) -> SSEEvent:
    """Aggregated, de-duplicated web sources consulted during the turn.

    Emitted once near end-of-turn (before ``message_end``) so the client attaches
    source cards to the just-finished assistant message. Each entry is a
    ``{url, title, snippet, site}`` dict. Persisted on the message too, so reload
    replays the same cards.
    """
    return SSEEvent(type=EventType.CITATIONS, payload={"citations": citations})


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


def approval_required(
    *,
    approval_id: str,
    conversation_id: str,
    tool_call_id: str,
    tool_name: str,
    arguments: dict[str, Any],
) -> SSEEvent:
    """A GRANTABLE tool call is paused, awaiting the user's authorization.

    ``approval_id`` is the key the client echoes back to the resolve endpoint
    (it equals ``tool_call_id``). ``arguments`` is a size-bounded preview so the
    user can see what the tool would do before allowing it.
    """
    return SSEEvent(
        type=EventType.APPROVAL_REQUIRED,
        payload={
            "approval_id": approval_id,
            "conversation_id": conversation_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def approval_resolved(*, approval_id: str, tool_call_id: str, decision: str) -> SSEEvent:
    """A pending approval was settled (approve / approve_always / deny / timeout).

    Lets the client clear the inline prompt; ``decision`` mirrors the resolution
    (a timeout resolves as ``deny``).
    """
    return SSEEvent(
        type=EventType.APPROVAL_RESOLVED,
        payload={
            "approval_id": approval_id,
            "tool_call_id": tool_call_id,
            "decision": decision,
        },
    )


def workspace_op_required(
    *,
    request_id: str,
    conversation_id: str,
    root_id: str,
    op: str,
    args: dict[str, Any],
) -> SSEEvent:
    """A local-workspace op is paused, awaiting the desktop client to run it.

    The server-side ``LocalWorkspace`` cannot touch the user's disk; it emits this
    so the bound desktop runs ``op`` (read / list / grep / …) against the real
    local directory and posts the structured result back to the ops resolve
    endpoint, keyed by ``request_id``. ``root_id`` names which of the desktop's
    authorized FS roots to operate on (the desktop's own traversal guard then
    keeps ``args`` paths inside it).

    Unlike ``approval_required`` (whose ``arguments`` is a size-bounded *preview*),
    ``args`` is the full op payload — the client must have everything it needs to
    actually perform the op (e.g. the bytes of a write). This event is transport,
    not part of the multi-agent journal, so it is never persisted/replayed.
    """
    return SSEEvent(
        type=EventType.WORKSPACE_OP_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "root_id": root_id,
            "op": op,
            "args": args,
        },
    )


def message_end(
    finish_reason: FinishReason,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    reasoning_tokens: int = 0,
    cache_hit_tokens: int = 0,
    cache_miss_tokens: int = 0,
    rounds: int = 0,
    cost: dict[str, Any] | None = None,
) -> SSEEvent:
    """End-of-turn event carrying the turn's total usage + cost (回合总账).

    ``usage`` keeps the long ``*_tokens`` keys (back-compat) and now also carries
    the cache hit/miss split, so the bill can be shown honestly. ``cost`` is the
    turn total ``{input, cached, output, total, currency}`` in integer nano-USD
    (sum of the per-run prices — see ``costing.aggregate_cost``); ``None`` on the
    error / not-found paths where no turn ran.
    """
    return SSEEvent(
        type=EventType.MESSAGE_END,
        payload={
            "finish_reason": finish_reason,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "reasoning_tokens": reasoning_tokens,
                "cache_hit_tokens": cache_hit_tokens,
                "cache_miss_tokens": cache_miss_tokens,
            },
            "cost": cost,
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


def run_started(
    run_id: str,
    agent_id: str,
    *,
    parent_run_id: str | None = None,
    kind: str = "agent",
) -> SSEEvent:
    """A Run node entered RUNNING.

    ``parent_run_id`` (the delegating run, ``None`` at the turn root) and ``kind``
    (agent / arena / synthesis) are 阶段2 声明位: every 阶段1 worker is a flat
    ``agent`` under the CEO, so these are constant for now, but the contract is
    pre-wired so nested delegation + synthesis nodes need no further event change.
    """
    return SSEEvent(
        type=EventType.RUN_STARTED,
        payload={
            "run_id": run_id,
            "agent_id": agent_id,
            "parent_run_id": parent_run_id,
            "kind": kind,
        },
    )


def run_output_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.RUN_OUTPUT_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
    )


def run_reasoning_delta(run_id: str, agent_id: str, delta: str) -> SSEEvent:
    """A delegated worker's thinking increment — the reasoning twin of
    ``run_output_delta`` (run-scoped, so the team UI can stream a worker's
    思考全文 into its run-detail live instead of discarding it). Journaled, so a
    reload replays the same thinking through the client-side fold.
    """
    return SSEEvent(
        type=EventType.RUN_REASONING_DELTA,
        payload={"run_id": run_id, "agent_id": agent_id, "delta": delta},
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
    """A Run finished — lights up one team-payroll row live (§七B).

    ``role`` is the cost-ledger category (阶段1 workers are always ``member``);
    ``usage`` is the ledger short-key form (``{input, output, reasoning,
    cache_hit, cache_miss}``) and ``cost`` the priced ``{input, cached, output,
    total, currency}`` (nano-USD). Both default to a zeroed shape (not omitted),
    so the client always gets a full, typed object — a run that never metered the
    LLM simply shows zeros (rendered as「—」, per §七5).
    """
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


# Event types that make up the multi-agent execution journal: persisted on the
# assistant message (messages.runs) so a past turn's team graph replays on reload
# through the same client-side fold as the live stream.
_JOURNAL_EVENT_TYPES = frozenset(
    {
        EventType.RUN_PLAN,
        EventType.RUN_STARTED,
        EventType.RUN_OUTPUT_DELTA,
        EventType.RUN_REASONING_DELTA,
        EventType.RUN_COMPLETED,
        EventType.RUN_FAILED,
        EventType.RUN_PROGRESS,
        EventType.TOOL_USE_START,
        EventType.TOOL_USE_END,
    }
)


class EventSink:
    """Async queue bridging execution (producer) and SSE (consumer).

    Lifecycle events are guaranteed delivery; content deltas can be dropped
    under backpressure (not implemented yet — unbounded queue for MVP).
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._closed = False
        # Ordered run/tool events of this turn (the multi-agent execution
        # journal), accumulated as they are emitted so the team graph can be
        # persisted and replayed. Empty for a pure single-agent turn.
        self._journal: list[dict[str, Any]] = []

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            if event.type in _JOURNAL_EVENT_TYPES:
                self._journal.append(
                    {
                        "type": event.type.value,
                        "payload": event.payload,
                        "timestamp": event.timestamp,
                    }
                )
            self._queue.put_nowait(event)

    def execution_journal(self) -> list[dict[str, Any]] | None:
        """This turn's ordered run/tool events, or None if it never delegated.

        Returns None unless a ``run_plan`` was emitted, so a single-agent turn
        (whose only journalled events would be the CEO's own tool calls) persists
        no runs payload.
        """
        has_plan = any(e["type"] == EventType.RUN_PLAN.value for e in self._journal)
        return self._journal if has_plan else None

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
