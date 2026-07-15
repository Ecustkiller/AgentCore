"""EventSink — async queue bridging execution and SSE delivery."""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events.journal_config import (
    _HISTORY_COALESCE_RUN,
    _HISTORY_COALESCE_TURN,
    _HISTORY_SKIP_TYPES,
    _JOURNAL_EVENT_TYPES,
    _JOURNAL_SURFACE_TYPES,
    cap_process_result,
)
from agentcore.runtime.events.stream_checkpointer import StreamCheckpointer
from agentcore.runtime.events.types import EventType, SSEEvent
from agentcore.runtime.facts import Fact, record_turn_fact

# Orchestration tools hand the turn to a sub-team and open a team execution. Their
# captain-level call is NOT rendered as a tool step — the `team` marker (emitted at
# run_plan) stands in its place as the collaboration graph's timeline slot. Mirrors
# the frontend `ORCHESTRATION_TOOLS` (lib/processTimeline.ts); keep the two in lockstep.
# Shared with the conformance oracle (projection.py) so live + golden agree.
ORCHESTRATION_TOOLS = frozenset({"delegate", "debate"})

logger = get_logger(__name__)


class EventSink:
    """Async queue bridging execution (producer) and SSE (consumer)."""

    def __init__(
        self,
        *,
        conversation_id: str | None = None,
        message_id: str | None = None,
    ) -> None:
        self._queue: asyncio.Queue[SSEEvent | None] = asyncio.Queue()
        self._persist_barriers: asyncio.Queue[asyncio.Future[int | None] | None] = asyncio.Queue()
        self._closed = False
        self._detached = False
        self._history: list[SSEEvent] = []
        self._journal: list[dict[str, Any]] = []
        self._process: list[dict[str, Any]] = []
        # Per-worker-run 思考·正文·工具 timeline (对称 CEO ``_process``). Keyed by run_id;
        # tools tagged with ``run_id`` land here (not on the captain bubble). Persisted as
        # ``runs.run_processes`` so reload matches live interleaving — ``message_final``
        # splice is NOT the worker timeline source.
        self._run_processes: dict[str, list[dict[str, Any]]] = {}
        self._has_run_plan = False
        self._has_tool = False
        self._conversation_id = conversation_id
        self._message_id = message_id
        self._checkpointer: StreamCheckpointer | None = None
        if conversation_id and message_id:
            self._try_start_stream_checkpointer()

    def bind_content_checkpoint(
        self,
        *,
        conversation_id: str,
        message_id: str,
    ) -> None:
        """Wire stream-segment durability for this turn's assistant row (P1).

        Name kept for call-site stability; the 10s ``messages.content`` checkpoint
        loop is retired in favour of ``StreamCheckpointer`` → ``turn_stream_state``.
        """
        self._conversation_id = conversation_id
        self._message_id = message_id
        self._try_start_stream_checkpointer()

    def _try_start_stream_checkpointer(self) -> None:
        if self._checkpointer is not None or self._closed or not self._message_id:
            return
        self._checkpointer = StreamCheckpointer(turn_id=self._message_id)
        self._checkpointer.start()

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            persist_future: asyncio.Future[int | None] | None = None
            if event.type in _JOURNAL_EVENT_TYPES:
                self._journal.append(
                    {
                        "type": event.type.value,
                        "payload": event.payload,
                        "timestamp": event.timestamp,
                    }
                )
                persist_future = record_turn_fact(
                    Fact(
                        kind=event.type.value,
                        payload=event.payload,
                        ts=event.timestamp,
                    )
                )
            self._accumulate_process(event)
            self._record_history(event)
            if self._checkpointer is not None:
                self._checkpointer.observe(event)
            if not self._detached:
                self._queue.put_nowait(event)
                self._persist_barriers.put_nowait(persist_future)

    def _record_history(self, event: SSEEvent) -> None:
        t = event.type
        if t in _HISTORY_SKIP_TYPES:
            return
        if t in _HISTORY_COALESCE_TURN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            last = self._history[-1] if self._history else None
            if last is not None and last.type == t:
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload={"delta": delta}, timestamp=event.timestamp)
                )
            return
        if t in _HISTORY_COALESCE_RUN:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            run_id = event.payload.get("run_id")
            last = self._history[-1] if self._history else None
            if last is not None and last.type == t and last.payload.get("run_id") == run_id:
                last.payload["delta"] = (last.payload.get("delta") or "") + delta
            else:
                self._history.append(
                    SSEEvent(type=t, payload=dict(event.payload), timestamp=event.timestamp)
                )
            return
        if t == EventType.TOOL_USE_END:
            payload = dict(event.payload)
            payload["result"] = cap_process_result(payload.get("result"))
            self._history.append(SSEEvent(type=t, payload=payload, timestamp=event.timestamp))
            return
        self._history.append(SSEEvent(type=t, payload=event.payload, timestamp=event.timestamp))

    def detach(self) -> None:
        self._detached = True

    def take_over(self) -> list[SSEEvent]:
        while True:
            try:
                self._queue.get_nowait()
                with contextlib.suppress(asyncio.QueueEmpty):
                    self._persist_barriers.get_nowait()
            except asyncio.QueueEmpty:
                break
        snapshot = list(self._history)
        if self._closed:
            self._queue.put_nowait(None)
            self._persist_barriers.put_nowait(None)
        else:
            self._detached = False
        return snapshot

    def _has_marker(self, kind: str, key: str, value: str) -> bool:
        """Whether a positional marker step (team / checkpoint / ask / plan_review) for
        ``value`` is already in the timeline — keeps a replayed / multi-batch event from
        dropping a duplicate anchor."""
        return any(s.get("kind") == kind and s.get(key) == value for s in self._process)

    def _run_process(self, run_id: str) -> list[dict[str, Any]]:
        return self._run_processes.setdefault(run_id, [])

    def _accumulate_run_process(self, event: SSEEvent) -> None:
        """Accumulate a worker run's ProcessStep[] (mirrors captain ``_accumulate_process``)."""
        t = event.type
        payload = event.payload
        if t == EventType.RUN_REASONING_DELTA:
            run_id = payload.get("run_id") or ""
            delta = payload.get("delta") or ""
            if not run_id or not delta:
                return
            steps = self._run_process(run_id)
            if steps and steps[-1].get("kind") == "reasoning":
                steps[-1]["text"] += delta
            else:
                steps.append({"kind": "reasoning", "text": delta})
        elif t == EventType.RUN_OUTPUT_DELTA:
            run_id = payload.get("run_id") or ""
            delta = payload.get("delta") or ""
            if not run_id or not delta:
                return
            steps = self._run_process(run_id)
            if steps and steps[-1].get("kind") == "content":
                steps[-1]["text"] += delta
            else:
                steps.append({"kind": "content", "text": delta})
        elif t == EventType.RUN_OUTPUT_RESET:
            run_id = payload.get("run_id") or ""
            if not run_id:
                return
            steps = self._run_process(run_id)
            while steps and steps[-1].get("kind") == "content":
                steps.pop()
            steps.append({"kind": "rework"})
        elif t == EventType.TOOL_USE_START:
            run_id = payload.get("run_id") or ""
            if not run_id:
                return
            self._run_process(run_id).append(
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
            run_id = payload.get("run_id") or ""
            if not run_id:
                return
            call_id = payload.get("tool_call_id", "")
            result = cap_process_result(payload.get("result"))
            display = payload.get("display")
            for step in reversed(self._run_process(run_id)):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = payload.get("status", "success")
                    if display is not None:
                        step["display"] = display
                    break

    def _accumulate_process(self, event: SSEEvent) -> None:
        # Worker-scoped deltas / tools accumulate on the per-run lane first (then the
        # captain branch no-ops them via run_id / event-type guards below).
        self._accumulate_run_process(event)
        t = event.type
        if t == EventType.RUN_PLAN:
            self._has_run_plan = True
            # 协作图时间线落点 (统一团队时间线): the FIRST run_plan of an execution drops a
            # zero-width `team` marker at its chronological spot, so the inline graph renders
            # there rather than at the bottom. Later batches (same execution_id) merge into the
            # same graph — one marker per execution.
            execution_id = event.payload.get("execution_id") or ""
            if execution_id and not self._has_marker("team", "execution_id", execution_id):
                self._process.append({"kind": "team", "execution_id": execution_id})
        elif t == EventType.REASONING_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "reasoning":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "reasoning", "text": delta})
        elif t == EventType.CONTENT_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return
            if self._process and self._process[-1].get("kind") == "content":
                self._process[-1]["text"] += delta
            else:
                self._process.append({"kind": "content", "text": delta})
        elif t == EventType.CONTENT_RESET:
            while self._process and self._process[-1].get("kind") == "content":
                self._process.pop()
        elif t == EventType.TOOL_USE_START:
            payload = event.payload
            # Skip a delegated worker's call (run-scoped — belongs to its run node, not the
            # captain timeline) and an orchestration call (delegate/debate — the `team` marker
            # stands in its place). Neither becomes a captain tool step.
            if payload.get("run_id") or payload.get("tool_name") in ORCHESTRATION_TOOLS:
                return
            self._has_tool = True
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
            if payload.get("run_id") or payload.get("tool_name") in ORCHESTRATION_TOOLS:
                return
            call_id = payload.get("tool_call_id", "")
            result = cap_process_result(payload.get("result"))
            display = payload.get("display")
            for step in reversed(self._process):
                if step.get("kind") == "tool" and step.get("id") == call_id:
                    step["result"] = result
                    step["status"] = payload.get("status", "success")
                    if display is not None:
                        step["display"] = display
                    break
        elif t == EventType.CHECKPOINT_REQUIRED:
            # 检查点时间线落点: a blocking ask_user pauses the CEO HERE — drop a positional
            # marker so the card replays at its real spot, not stamped at the bottom. The card
            # body is folded separately (client checkpointsFromEvents), keyed by this id.
            cid = event.payload.get("checkpoint_id") or ""
            if cid and not self._has_marker("checkpoint", "checkpoint_id", cid):
                self._process.append({"kind": "checkpoint", "checkpoint_id": cid})
        elif t == EventType.QUESTION_POSTED:
            # 非阻塞发问时间线落点: the CEO surfaced a question and kept working — marker only.
            aid = event.payload.get("ask_id") or ""
            if aid and not self._has_marker("ask", "ask_id", aid):
                self._process.append({"kind": "ask", "ask_id": aid})
        elif t == EventType.PLAN_REVIEW_REQUIRED:
            # 计划复核时间线落点: a plan-review gate pauses the turn HERE.
            cid = event.payload.get("checkpoint_id") or ""
            if cid and not self._has_marker("plan_review", "checkpoint_id", cid):
                self._process.append({"kind": "plan_review", "checkpoint_id": cid})
        elif t == EventType.TEAM_PREVIEW_REQUIRED:
            # 开工卡时间线落点: thin preview before first wave. Event order is
            # run_plan → team_preview_required, but product narrative is 开工卡 → 协作图 —
            # if a team marker already exists, insert before the last one; else append.
            cid = event.payload.get("checkpoint_id") or ""
            if cid and not self._has_marker("team_preview", "checkpoint_id", cid):
                marker = {"kind": "team_preview", "checkpoint_id": cid}
                for i in range(len(self._process) - 1, -1, -1):
                    if self._process[i].get("kind") == "team":
                        self._process.insert(i, marker)
                        break
                else:
                    self._process.append(marker)

    def seed_journal(self, events: list[dict[str, Any]]) -> None:
        self._journal.extend(events)

    def execution_journal(self) -> list[dict[str, Any]] | None:
        has_surface = any(e["type"] in _JOURNAL_SURFACE_TYPES for e in self._journal)
        return self._journal if has_surface else None

    def process_timeline(self) -> list[dict[str, Any]] | None:
        # Persist the timeline whenever it carries STRUCTURE beyond the CEO's own text —
        # a tool, the team graph, or an interaction marker (checkpoint / ask / plan_review).
        # A pure reasoning/content turn needs none (the content scalar IS the answer, and
        # reasoning rides its own column), matching the fold's "tool-less single-agent turn
        # → no process" so live / reload / golden stay aligned.
        structural = any(s.get("kind") not in ("reasoning", "content") for s in self._process)
        return self._process if structural else None

    def run_process_timelines(self) -> dict[str, list[dict[str, Any]]] | None:
        """Per-run ProcessStep[] maps for worker detail timelines (对称 CEO process).

        Persist any non-empty run timeline so reload keeps true interleaving (tools
        between thinking/output). Empty map → None (no field on the runs payload).
        """
        out = {rid: steps for rid, steps in self._run_processes.items() if steps}
        return out or None

    def streamed_content(self) -> str:
        """The CEO bubble's currently-streamed text — concatenated ``content``-kind
        process entries, honoring ``content_reset`` (reset pops them).

        断线别白干 (中途取消 salvage): the partial reply the user already saw, read off the
        turn's live accumulation so a turn CANCELLED before it persisted keeps that text
        instead of being replaced by a generic「连接中断」note. Empty for a turn that had
        streamed no assistant text yet (e.g. still mid-tool). Accumulates even while
        detached, so a disconnect that later cancels still recovers what streamed.
        """
        return "".join(
            step.get("text", "") for step in self._process if step.get("kind") == "content"
        )

    def streamed_reasoning(self) -> str:
        """CEO thinking text accumulated so far (process ``reasoning`` steps)."""
        return "".join(
            step.get("text", "") for step in self._process if step.get("kind") == "reasoning"
        )

    def stream_memory_snapshot(self) -> dict[str, str]:
        """In-memory stream-channel texts (for error/FAILED salvage merge)."""
        if self._checkpointer is None:
            return {}
        return self._checkpointer.memory_snapshot()

    async def flush_stream_state(self) -> None:
        """Best-effort flush of dirty stream segments (call before turn收口)."""
        if self._checkpointer is not None:
            await self._checkpointer.flush()

    def captain_context(self) -> list[dict[str, Any]] | None:
        from agentcore.runtime.runs.types import RunKind

        captain_run_id: str | None = None
        for e in self._journal:
            payload = e.get("payload") or {}
            if (
                e.get("type") == EventType.RUN_STARTED.value
                and payload.get("kind") == RunKind.CAPTAIN.value
            ):
                captain_run_id = payload.get("run_id")
                break
        if captain_run_id is None:
            return None
        found = False
        blocks: list[dict[str, Any]] = []
        for e in self._journal:
            payload = e.get("payload") or {}
            if (
                e.get("type") == EventType.RUN_CONTEXT.value
                and payload.get("run_id") == captain_run_id
            ):
                found = True
                blocks.extend(payload.get("blocks") or [])
        return blocks if found else None

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            if self._checkpointer is not None:
                # Schedule final flush without blocking close (SSE consumer may still drain).
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self._checkpointer.close())
                except RuntimeError:
                    pass
                self._checkpointer = None
            self._queue.put_nowait(None)
            self._persist_barriers.put_nowait(None)

    async def get(self) -> SSEEvent | None:
        event = await self._queue.get()
        if event is None:
            return None
        barrier = await self._persist_barriers.get()
        if barrier is not None:
            allocated = await barrier
            if allocated is not None:
                event.seq = allocated
        return event

    async def __aiter__(self):
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event
