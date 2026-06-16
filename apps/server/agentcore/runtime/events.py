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
    # User checkpoint (CEO ask_user): the CEO paused the turn to ask the user a
    # decision (continue / adjust / stop), then resolved. UNLIKE approvals (pure
    # transport), these two are journaled (see _JOURNAL_EVENT_TYPES) so the
    # question + answer replay inline on reload — the exchange is conversation, not
    # just gating.
    CHECKPOINT_REQUIRED = "checkpoint_required"
    CHECKPOINT_RESOLVED = "checkpoint_resolved"
    # Structured DAG checkpoint (结构化挂起 2a): a delegate step marked
    # ``checkpoint_after`` completed and the WaveScheduler paused at the wave
    # boundary before its dependents, awaiting the user's plan_review (continue /
    # stop). Distinct from ask_user (CEO mid-loop) — this is plan-declared and
    # scheduler-enforced. Journaled like checkpoints so the pause replays on reload.
    PLAN_REVIEW_REQUIRED = "plan_review_required"
    PLAN_REVIEW_RESOLVED = "plan_review_resolved"
    # Local-workspace op channel (双模式工作区 P2): a server-side LocalWorkspace
    # asks the bound desktop client to run a file/exec op against the real local
    # directory, then awaits the result posted back to the ops resolve endpoint.
    # Transport only — deliberately NOT journaled into the team graph.
    WORKSPACE_OP_REQUIRED = "workspace_op_required"
    # Local→云 handoff (双模式工作区 P2e / e1): a local workspace was archived over
    # the channel and snapshotted to object storage; carries the new snapshot id.
    # One-shot completion signal — not journaled into the team graph.
    HANDOFF_SNAPSHOT_DONE = "handoff_snapshot_done"
    # Local→云 handoff dispatch (双模式工作区 P2e / e2): the base snapshot was taken
    # and a cloud job accepted; carries the job id so the client can start polling
    # its status. The team run continues detached after this SSE closes.
    HANDOFF_JOB_STARTED = "handoff_job_started"
    # Local→云 handoff apply (双模式工作区 P2e / e3): the selected result changes were
    # written back to the local workspace over the channel; carries the per-file
    # outcome (applied / skipped / conflict / error) + counts. One-shot completion
    # signal emitted just before the apply SSE closes — not journaled.
    HANDOFF_APPLY_DONE = "handoff_apply_done"
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


def checkpoint_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    question: str,
    options: list[str],
    context: str = "",
    multiple: bool = False,
) -> SSEEvent:
    """The CEO paused the turn to ask the user a decision (ask_user checkpoint).

    ``checkpoint_id`` is the key the client echoes back to the resolve endpoint.
    ``question`` is the CEO-authored decision point; ``options`` are optional
    concrete choices to offer; ``context`` is optional supporting background.
    ``multiple`` tells the card to render the options as multi-select (checkboxes)
    rather than single-select (radios). Journaled (see ``_JOURNAL_EVENT_TYPES``) so
    a reload replays the prompt inline.
    """
    return SSEEvent(
        type=EventType.CHECKPOINT_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "question": question,
            "options": options,
            "context": context,
            "multiple": multiple,
        },
    )


def checkpoint_resolved(
    *, checkpoint_id: str, decision: str, note: str = "", selected: list[str] | None = None
) -> SSEEvent:
    """A pending checkpoint was settled (continue / adjust / stop / timeout).

    Lets the client flip the inline card to its resolved state; ``note`` carries
    the user's steer for ``adjust`` (or a closing remark for ``stop``), ``selected``
    the option(s) the user picked. Journaled alongside ``checkpoint_required`` so
    the settled outcome replays on reload.
    """
    return SSEEvent(
        type=EventType.CHECKPOINT_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
            "selected": selected or [],
        },
    )


def plan_review_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    steps: list[dict[str, Any]],
    pending: list[dict[str, Any]],
) -> SSEEvent:
    """A DAG ``checkpoint_after`` step finished; the scheduler paused for the user
    to review before its dependents run (结构化挂起 2a).

    ``checkpoint_id`` is the key the client echoes back to the resolve endpoint.
    ``steps`` are the just-completed checkpoint nodes (``{run_id, role, summary}``)
    the user is reviewing; ``pending`` is a peek at the downstream nodes about to
    run (``{run_id, role}``) so the card frames「看着已发生的、决定要不要放行未发生
    的」. Journaled (see ``_JOURNAL_EVENT_TYPES``) so the pause replays inline on
    reload.
    """
    return SSEEvent(
        type=EventType.PLAN_REVIEW_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "steps": steps,
            "pending": pending,
        },
    )


def plan_review_resolved(*, checkpoint_id: str, decision: str, note: str = "") -> SSEEvent:
    """A pending plan_review was settled (continue / stop / timeout).

    Lets the client flip the inline card to its resolved state; ``note`` carries an
    optional remark. Journaled alongside ``plan_review_required`` so the settled
    outcome replays on reload.
    """
    return SSEEvent(
        type=EventType.PLAN_REVIEW_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
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


def handoff_snapshot_done(
    *, snapshot_id: str, conversation_id: str, size_bytes: int
) -> SSEEvent:
    """A local→云 handoff snapshot (双模式工作区 P2e / e1) completed.

    The bound desktop archived its local workspace over the channel; the server
    staged it and snapshotted it to object storage. Carries the new ``snapshot_id``
    (and its ``size_bytes``) so the client can refresh the snapshot list and
    confirm the backup. Emitted once, just before the handoff SSE closes.
    """
    return SSEEvent(
        type=EventType.HANDOFF_SNAPSHOT_DONE,
        payload={
            "snapshot_id": snapshot_id,
            "conversation_id": conversation_id,
            "size_bytes": size_bytes,
        },
    )


def handoff_job_started(
    *, job_id: str, conversation_id: str, job_conversation_id: str
) -> SSEEvent:
    """A local→云 handoff cloud job (双模式工作区 P2e / e2) was accepted.

    The base snapshot of the user's local files is captured and the team run is
    spawned detached on the server. Carries the ``job_id`` (so the client polls
    its status) and the hidden ``job_conversation_id`` that hosts the team's
    messages / cost / run graph for later replay. Emitted once, just before the
    dispatch SSE closes — the cloud run continues in the background past it.
    """
    return SSEEvent(
        type=EventType.HANDOFF_JOB_STARTED,
        payload={
            "job_id": job_id,
            "conversation_id": conversation_id,
            "job_conversation_id": job_conversation_id,
        },
    )


def handoff_apply_done(
    *, job_id: str, conversation_id: str, results: list[dict[str, Any]]
) -> SSEEvent:
    """A local→云 handoff apply (双模式工作区 P2e / e3) finished writing back.

    The user's selected result changes were replayed onto the local workspace over
    the channel (WRITE_BYTES / DELETE). Carries the per-file ``results`` (each
    ``path`` + ``status`` + ``change_type`` + ``detail``) and the rolled-up counts,
    so the PR card can mark each row done and surface any unresolved conflicts.
    Emitted once, just before the apply SSE closes.
    """
    counts = {"applied": 0, "skipped": 0, "conflict": 0, "error": 0}
    for r in results:
        status = str(r.get("status", ""))
        if status in counts:
            counts[status] += 1
    return SSEEvent(
        type=EventType.HANDOFF_APPLY_DONE,
        payload={
            "job_id": job_id,
            "conversation_id": conversation_id,
            "results": results,
            "applied": counts["applied"],
            "skipped": counts["skipped"],
            "conflicts": counts["conflict"],
            "errors": counts["error"],
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
    revision: int = 0,
) -> SSEEvent:
    """A Run node entered RUNNING.

    ``kind`` is the node type: ``captain`` for the CEO chat-loop root (the turn's
    汇聚点, ``parent_run_id is None``), ``agent`` for a delegated / DAG worker. (No
    arena/debate kind — 多轮辩论 rides an ``agent`` DAG with stance/round tags.)
    ``parent_run_id`` is the delegating run — the CEO
    captain for a top-level worker, the captain worker itself for a 阶段2 nested
    sub-worker — so the graph groups the tree without waiting for the run frame.

    ``revision`` (乙 热修 P4) is the version number of a 定向唤回 续写: ``0`` for an
    ordinary first-time run, ``≥2`` for a revision (the original is v1, so the first
    revision is v2). For a revision ``parent_run_id`` is the ORIGINAL run it
    revises, so the frontend hangs a「修订 vN」child node off it and builds the
    version chain — without this flag a revision is indistinguishable from a 阶段2
    nested sub-worker (which also carries a worker ``parent_run_id``).
    """
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
        # User checkpoints (ask_user): journaled so the question + answer replay
        # inline on reload, unlike the (transport-only) approval / workspace-op
        # events.
        EventType.CHECKPOINT_REQUIRED,
        EventType.CHECKPOINT_RESOLVED,
        # Structured DAG checkpoints (checkpoint_after): journaled so the pause +
        # its resolution replay inline on reload, same as ask_user checkpoints.
        EventType.PLAN_REVIEW_REQUIRED,
        EventType.PLAN_REVIEW_RESOLVED,
    }
)

# Event types whose presence alone is enough to persist the journal — a turn that
# never delegated (no run_plan) but did raise a checkpoint still has a journal
# worth replaying. (Tool calls on their own do not: a single-agent turn's own
# tool I/O is not replayed through the team-graph journal — it rides the separate
# process timeline below instead.)
_JOURNAL_SURFACE_TYPES = frozenset(
    {
        EventType.RUN_PLAN.value,
        EventType.CHECKPOINT_REQUIRED.value,
        EventType.PLAN_REVIEW_REQUIRED.value,
    }
)

# A single tool result can be large (a read_url page, a long grep). The process
# timeline is a display artifact (the inline「思考+工具」面板), not the source of
# truth, so each persisted result is capped — enough for a meaningful preview
# without bloating the message row. The live SSE still carries the full result.
_PROCESS_RESULT_CAP = 8000


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
        # Single-agent process timeline: the CEO's own thinking interleaved with
        # its tool calls, in emission order, folded into compact segments (one
        # reasoning step coalesces consecutive deltas; one step per tool call).
        # This is what the inline「思考过程」面板 replays for a single-agent turn —
        # the team-graph journal above stays None there. ``_has_run_plan`` marks
        # the turn as multi-agent (graph instead), ``_has_tool`` gates persistence
        # (a tool-less turn replays from reasoning_content, no process payload).
        self._process: list[dict[str, Any]] = []
        self._has_run_plan = False
        self._has_tool = False

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
            self._accumulate_process(event)
            self._queue.put_nowait(event)

    def _accumulate_process(self, event: SSEEvent) -> None:
        """Fold one event into the single-agent process timeline.

        Mirrors the client-side build (streamConversation) so a live turn and its
        reloaded twin produce the same panel: reasoning deltas coalesce into the
        trailing reasoning step; each tool call appends a step that its matching
        ``tool_use_end`` later resolves (result + status).
        """
        t = event.type
        if t == EventType.RUN_PLAN:
            self._has_run_plan = True
        elif t == EventType.REASONING_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "reasoning":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "reasoning", "text": delta})
        elif t == EventType.TOOL_USE_START:
            self._has_tool = True
            payload = event.payload
            self._process.append(
                {
                    "kind": "tool",
                    "id": payload.get("tool_call_id", ""),
                    "tool_name": payload.get("tool_name", ""),
                    "arguments": payload.get("arguments") or {},
                    "result": None,
                    "status": "running",
                }
            )
        elif t == EventType.TOOL_USE_END:
            payload = event.payload
            call_id = payload.get("tool_call_id", "")
            result = payload.get("result")
            if isinstance(result, str) and len(result) > _PROCESS_RESULT_CAP:
                result = result[:_PROCESS_RESULT_CAP] + "…"
            for step in reversed(self._process):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = payload.get("status", "success")
                    break

    def seed_journal(self, events: list[dict[str, Any]]) -> None:
        """Pre-load the journal with a paused turn's pre-pause events (结构化挂起 2b resume).

        A resumed turn runs on a FRESH sink, but its persisted ``messages.runs`` must
        replay the WHOLE team graph — the pre-pause run_plan + finished workers + the
        plan_review pause, then the post-resume tail. Seeding extends only the journal
        (persistence/replay), NOT the live SSE queue: the client already saw the
        pre-pause portion (or loads it from the persisted message), so the resume
        stream carries only new events. A re-pause during resume then captures the
        cumulative journal naturally.
        """
        self._journal.extend(events)

    def execution_journal(self) -> list[dict[str, Any]] | None:
        """This turn's ordered run/tool events, or None if there is nothing to replay.

        Returns None unless the turn either delegated (``run_plan``) or raised a
        checkpoint (``checkpoint_required``) — a plain single-agent turn (whose
        only journalled events would be the CEO's own tool calls) persists no runs
        payload, but a single-agent turn that paused to ask the user does (so the
        exchange replays).
        """
        has_surface = any(
            e["type"] in _JOURNAL_SURFACE_TYPES for e in self._journal
        )
        return self._journal if has_surface else None

    def process_timeline(self) -> list[dict[str, Any]] | None:
        """This single-agent turn's「思考+工具」timeline, or None.

        None for a multi-agent turn (``run_plan`` → the team graph carries the
        activity instead) or a turn that used no tool (a thinking-only turn
        replays from ``reasoning_content`` as one segment — no process payload
        needed). Otherwise the ordered reasoning/tool steps the client folds into
        the inline process panel and persists on ``messages.runs.process``.
        """
        if self._has_run_plan or not self._has_tool:
            return None
        return self._process or None

    def close(self) -> None:
        """Signal end-of-stream to consumer."""
        if not self._closed:
            self._closed = True
            self._queue.put_nowait(None)

    async def get(self) -> "SSEEvent | None":
        """Pull the next event, or ``None`` once the stream is closed.

        The SSE layer consumes via this (not ``__aiter__``) so it can race the
        pull against a heartbeat timeout — a slow turn keeps the connection warm
        with keep-alive frames instead of looking dead to the client.
        """
        return await self._queue.get()

    async def __aiter__(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
