"""EventSink — async queue bridging execution and SSE delivery."""

from __future__ import annotations

import asyncio
import contextlib
import copy
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events.chat import content_delta
from agentcore.runtime.events.journal_config import (
    _HISTORY_COALESCE_RUN,
    _HISTORY_COALESCE_TURN,
    _HISTORY_SKIP_TYPES,
    _JOURNAL_EVENT_TYPES,
    _JOURNAL_SURFACE_TYPES,
    cap_process_result,
)
from agentcore.runtime.events.process_persist import (
    ProcessPersistCursor,
    should_persist_on_close,
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


def _step_has_marker(steps: list[dict[str, Any]], kind: str, key: str, value: str) -> bool:
    return any(s.get("kind") == kind and s.get(key) == value for s in steps)


def _insert_marker_step(
    steps: list[dict[str, Any]],
    marker: dict[str, Any],
    *,
    before_last_team: bool = False,
) -> None:
    """Insert a positional marker into ``steps`` (caller owns dedup).

    ``before_last_team`` mirrors team_preview product narrative: 开工卡 sits just
    before the collaboration-graph ``team`` marker, not after it.
    """
    if before_last_team:
        for i in range(len(steps) - 1, -1, -1):
            if steps[i].get("kind") == "team":
                steps.insert(i, marker)
                return
    steps.append(marker)


def _marker_spec_for_required(
    event_type: EventType | str,
    payload: dict[str, Any],
) -> tuple[dict[str, Any], bool] | None:
    """Build (marker_step, before_last_team) for a timeline-marker surface event.

    Covers ``*_required`` / ask / raised ``run_escalation`` (统一时间线二期). Shared by
    ``EventSink._accumulate_process`` and suspension capture (G7) so live emit and
    ``turn_paused`` snapshot stay lockstep. Returns None when the event is not a
    marker surface or the id is empty.
    """
    t = event_type if isinstance(event_type, EventType) else EventType(event_type)
    if t == EventType.CHECKPOINT_REQUIRED:
        cid = payload.get("checkpoint_id") or ""
        if not cid:
            return None
        return {"kind": "checkpoint", "checkpoint_id": cid}, False
    if t == EventType.QUESTION_POSTED:
        aid = payload.get("ask_id") or ""
        if not aid:
            return None
        return {"kind": "ask", "ask_id": aid}, False
    if t == EventType.PLAN_REVIEW_REQUIRED:
        cid = payload.get("checkpoint_id") or ""
        if not cid:
            return None
        return {"kind": "plan_review", "checkpoint_id": cid}, False
    if t == EventType.TEAM_PREVIEW_REQUIRED:
        cid = payload.get("checkpoint_id") or ""
        if not cid:
            return None
        return {"kind": "team_preview", "checkpoint_id": cid}, True
    if t in (EventType.ESCALATION_REQUIRED, EventType.RUN_ESCALATION):
        eid = payload.get("escalation_id") or ""
        if not eid:
            return None
        return {"kind": "escalation", "escalation_id": eid}, False
    if t == EventType.APPROVAL_REQUIRED:
        aid = payload.get("approval_id") or ""
        if not aid:
            return None
        return {"kind": "approval", "approval_id": aid}, False
    if t == EventType.DELEGATION_AUTHORIZATION_REQUIRED:
        aid = payload.get("authorization_id") or ""
        if not aid:
            return None
        # 产品修正（统一时间线二期落地后拍板）：委派授权与开工卡同属「放行开工」族，
        # 统一叙事 授权 → 团队干活 —— 与 team_preview 同锚定，排协作图 team 标记之前。
        # 仅此一 kind；escalation / approval 维持事件时刻、排图后。
        return {"kind": "delegation_authorization", "authorization_id": aid}, True
    return None


def synthesize_required_marker(
    steps: list[dict[str, Any]],
    event_type: EventType | str,
    payload: dict[str, Any],
) -> bool:
    """Synthesize a marker step into ``steps`` from a ``*_required`` event (G7).

    Dedups within ``steps`` (``_has_marker`` semantics on the target list). Returns
    whether a marker was inserted. Capture side uses this on the live process lane
    (then flushes to journal) so the pause-anchor marker lands even though the
    required event emits *after* ``persist_suspension_capture``.
    """
    spec = _marker_spec_for_required(event_type, payload)
    if spec is None:
        return False
    marker, before_last_team = spec
    kind = marker["kind"]
    key = next(k for k in marker if k != "kind")
    value = marker[key]
    if _step_has_marker(steps, kind, key, value):
        return False
    _insert_marker_step(steps, marker, before_last_team=before_last_team)
    return True


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
        # Resume-seeded captain / worker timelines (G1/G7). Deep-copied on seed; never
        # mixed into live ``_process`` / ``_run_processes``. Persist projection merges
        # seeded⊕live; streamed_* and content_reset read/mutate live only.
        self._seeded_process: list[dict[str, Any]] = []
        self._seeded_run_processes: dict[str, list[dict[str, Any]]] = {}
        # Per-worker-run 思考·正文·工具 timeline (对称 CEO ``_process``). Keyed by run_id;
        # tools tagged with ``run_id`` land here (not on the captain bubble). Persisted as
        # ``runs.run_processes`` so reload matches live interleaving — ``message_final``
        # splice is NOT the worker timeline source.
        self._run_processes: dict[str, list[dict[str, Any]]] = {}
        # Progressive process_* / run_process_* journal cursor (ordinal idempotent).
        self._process_cursor = ProcessPersistCursor()
        self._has_run_plan = False
        self._has_tool = False
        self._conversation_id = conversation_id
        self._message_id = message_id
        self._checkpointer: StreamCheckpointer | None = None
        # G6: after content_reset, display-only reinject this text into history + SSE
        # (skip process / checkpointer). None = hook unset (status-quo behaviour).
        self._content_reset_reinjection: str | None = None
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

    def set_content_reset_reinjection(self, text: str | None) -> None:
        """G6: after each ``content_reset``, display-only reinject ``text`` (or clear hook).

        Resume pipeline sets pre_pause so client bubble reset does not wipe the
        suspended-turn base. Pass ``None`` to disable (status quo).
        """
        self._content_reset_reinjection = text

    def _emit_display_only(self, event: SSEEvent) -> None:
        """History + SSE only — skip process accumulation, journal, and checkpointer."""
        if self._closed:
            return
        self._record_history(event)
        if not self._detached:
            self._queue.put_nowait(event)
            self._persist_barriers.put_nowait(None)

    @staticmethod
    def _combine_persist_barriers(
        futures: list[asyncio.Future[int | None] | None],
    ) -> asyncio.Future[int | None] | None:
        """One SSE barrier that awaits every scheduled journal write for this event.

        Process-lane facts must land before (or with) the closing DURABLE so mid-run
        refresh can fold journal alone — invariant: live-visible process ⇒ journal.
        """
        pending = [f for f in futures if f is not None]
        if not pending:
            return None
        if len(pending) == 1:
            return pending[0]
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return pending[-1]
        combined: asyncio.Future[int | None] = loop.create_future()

        async def _wait() -> None:
            seq: int | None = None
            for fut in pending:
                try:
                    allocated = await fut
                except Exception as exc:  # noqa: BLE001 — barrier must not hang SSE
                    if not combined.done():
                        combined.set_exception(exc)
                    return
                if allocated is not None:
                    seq = allocated
            if not combined.done():
                combined.set_result(seq)

        loop.create_task(_wait())
        return combined

    def emit(self, event: SSEEvent) -> None:
        if not self._closed:
            # Accumulate FIRST: closed process_* / run_process_* schedule before the
            # DURABLE fact that closed them (journal interleave == live timeline).
            process_futures = self._accumulate_process(event)
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
            self._record_history(event)
            if self._checkpointer is not None:
                self._checkpointer.observe(event)
            if not self._detached:
                self._queue.put_nowait(event)
                self._persist_barriers.put_nowait(
                    self._combine_persist_barriers([*process_futures, persist_future])
                )
            # G6: reinject after content_reset is fully processed (history + SSE +
            # checkpointer already saw the reset). Display-only path skips process /
            # checkpointer so salvage and persist timelines stay unduplicated.
            if (
                event.type is EventType.CONTENT_RESET
                and self._content_reset_reinjection is not None
            ):
                self._emit_display_only(content_delta(self._content_reset_reinjection))

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
        dropping a duplicate anchor. Scans seeded ⊕ live so resume-seeded anchors dedup."""
        return _step_has_marker(self._seeded_process, kind, key, value) or _step_has_marker(
            self._process, kind, key, value
        )

    def _run_process(self, run_id: str) -> list[dict[str, Any]]:
        return self._run_processes.setdefault(run_id, [])

    def _persist_closed_captain_text(self) -> list[Any]:
        """Journal the open captain text step that a boundary is about to close."""
        merged = self.raw_process()
        if not merged or not should_persist_on_close(merged[-1]):
            return []
        return self._process_cursor.persist_captain_range(merged, start=0, end=len(merged))

    def _persist_closed_run_text(self, run_id: str) -> list[Any]:
        steps = self._run_process(run_id)
        seeded = self._seeded_run_processes.get(run_id) or []
        merged = [*seeded, *steps] if seeded else list(steps)
        if not merged or not should_persist_on_close(merged[-1]):
            return []
        return self._process_cursor.persist_run_range(run_id, merged, start=0, end=len(merged))

    def flush_process_to_journal(self) -> None:
        """Persist every not-yet-journaled process / run_process step (finalize / pause).

        Call at semantic turn boundaries so open trailing text steps and markers land
        before ``turn_end`` / ``turn_paused``. Idempotent via the ordinal cursor.
        """
        self._process_cursor.persist_new_captain_tail(self.raw_process())
        for rid, steps in self._merged_run_processes().items():
            self._process_cursor.persist_new_run_tail(rid, steps)

    def persist_required_marker(self, event_type: Any, payload: dict[str, Any]) -> None:
        """Insert a pause-anchor marker into the live captain lane and journal it.

        The ``*_required`` SSE is emitted *after* suspension capture, so the capture
        path must synthesize the marker itself for process_* progressive persistence.
        ``before_last_team`` may insert *before* the ordinal cursor — schedule the
        marker fact directly rather than relying on append-only range persist.
        """
        from agentcore.runtime.events.process_persist import schedule_process_step

        if not synthesize_required_marker(self._process, event_type, payload):
            return
        spec = _marker_spec_for_required(event_type, payload)
        if spec is None:
            return
        marker, _before_last_team = spec
        schedule_process_step(marker)
        # Cursor past the full merged lane so a later flush does not rewrite steps.
        self._process_cursor.seed_captain(len(self.raw_process()))

    def _accumulate_run_process(self, event: SSEEvent) -> list[Any]:
        """Accumulate a worker run's ProcessStep[] (mirrors captain ``_accumulate_process``)."""
        futures: list[Any] = []
        t = event.type
        payload = event.payload
        if t == EventType.RUN_REASONING_DELTA:
            run_id = payload.get("run_id") or ""
            delta = payload.get("delta") or ""
            if not run_id or not delta:
                return futures
            steps = self._run_process(run_id)
            if steps and steps[-1].get("kind") == "reasoning":
                steps[-1]["text"] += delta
            else:
                if steps and should_persist_on_close(steps[-1]):
                    futures.extend(self._persist_closed_run_text(run_id))
                steps.append({"kind": "reasoning", "text": delta})
        elif t == EventType.RUN_OUTPUT_DELTA:
            run_id = payload.get("run_id") or ""
            delta = payload.get("delta") or ""
            if not run_id or not delta:
                return futures
            steps = self._run_process(run_id)
            if steps and steps[-1].get("kind") == "content":
                steps[-1]["text"] += delta
            else:
                if steps and should_persist_on_close(steps[-1]):
                    futures.extend(self._persist_closed_run_text(run_id))
                steps.append({"kind": "content", "text": delta})
        elif t == EventType.RUN_OUTPUT_RESET:
            run_id = payload.get("run_id") or ""
            if not run_id:
                return futures
            steps = self._run_process(run_id)
            # Discard open (unpersisted) trailing content — do not journal it.
            while steps and steps[-1].get("kind") == "content":
                steps.pop()
            steps.append({"kind": "rework"})
            seeded = self._seeded_run_processes.get(run_id) or []
            merged = [*seeded, *steps] if seeded else list(steps)
            futures.extend(self._process_cursor.persist_new_run_tail(run_id, merged))
        elif t == EventType.TOOL_USE_START:
            run_id = payload.get("run_id") or ""
            if not run_id:
                return futures
            futures.extend(self._persist_closed_run_text(run_id))
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
                return futures
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
            seeded = self._seeded_run_processes.get(run_id) or []
            live = self._run_process(run_id)
            merged = [*seeded, *live] if seeded else list(live)
            futures.extend(self._process_cursor.persist_new_run_tail(run_id, merged))
        return futures

    def _accumulate_process(self, event: SSEEvent) -> list[Any]:
        # Worker-scoped deltas / tools accumulate on the per-run lane first (then the
        # captain branch no-ops them via run_id / event-type guards below).
        futures = self._accumulate_run_process(event)
        t = event.type
        if t == EventType.RUN_PLAN:
            self._has_run_plan = True
            # 协作图时间线落点 (统一团队时间线): the FIRST run_plan of an execution drops a
            # zero-width `team` marker at its chronological spot, so the inline graph renders
            # there rather than at the bottom. Later batches (same execution_id) merge into the
            # same graph — one marker per execution.
            execution_id = event.payload.get("execution_id") or ""
            if execution_id and not self._has_marker("team", "execution_id", execution_id):
                futures.extend(self._persist_closed_captain_text())
                self._process.append({"kind": "team", "execution_id": execution_id})
        elif t == EventType.REASONING_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return futures
            if self._process and self._process[-1].get("kind") == "reasoning":
                self._process[-1]["text"] += delta
            else:
                if self._process and should_persist_on_close(self._process[-1]):
                    futures.extend(self._persist_closed_captain_text())
                self._process.append({"kind": "reasoning", "text": delta})
        elif t == EventType.CONTENT_DELTA:
            delta = event.payload.get("delta") or ""
            if not delta:
                return futures
            if self._process and self._process[-1].get("kind") == "content":
                self._process[-1]["text"] += delta
            else:
                if self._process and should_persist_on_close(self._process[-1]):
                    futures.extend(self._persist_closed_captain_text())
                self._process.append({"kind": "content", "text": delta})
        elif t == EventType.CONTENT_RESET:
            # Discard open (unpersisted) trailing content — do not journal discarded prose.
            while self._process and self._process[-1].get("kind") == "content":
                self._process.pop()
        elif t == EventType.TOOL_USE_START:
            payload = event.payload
            # Skip a delegated worker's call (run-scoped — belongs to its run node, not the
            # captain timeline) and an orchestration call (delegate/debate — the `team` marker
            # stands in its place). Neither becomes a captain tool step.
            if payload.get("run_id") or payload.get("tool_name") in ORCHESTRATION_TOOLS:
                return futures
            futures.extend(self._persist_closed_captain_text())
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
                return futures
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
            futures.extend(self._process_cursor.persist_new_captain_tail(self.raw_process()))
        elif t in (
            EventType.CHECKPOINT_REQUIRED,
            EventType.QUESTION_POSTED,
            EventType.PLAN_REVIEW_REQUIRED,
            EventType.TEAM_PREVIEW_REQUIRED,
            EventType.ESCALATION_REQUIRED,
            EventType.RUN_ESCALATION,
            EventType.APPROVAL_REQUIRED,
            EventType.DELEGATION_AUTHORIZATION_REQUIRED,
        ):
            # Positional card / 痕迹 anchors — shared builder with synthesize_required_marker
            # (G7). Dedup scans seeded⊕live; insert targets live only.
            spec = _marker_spec_for_required(t, event.payload)
            if spec is None:
                return futures
            marker, before_last_team = spec
            kind = marker["kind"]
            key = next(k for k in marker if k != "kind")
            if self._has_marker(kind, key, marker[key]):
                return futures
            futures.extend(self._persist_closed_captain_text())
            _insert_marker_step(self._process, marker, before_last_team=before_last_team)
            # Middle-insert (before_last_team) breaks pure append ordinals — flush the
            # full tail so the new marker and any shifted steps are journaled once.
            futures.extend(self._process_cursor.persist_new_captain_tail(self.raw_process()))
        return futures

    def seed_journal(self, events: list[dict[str, Any]]) -> None:
        self._journal.extend(events)

    def seed_process(self, steps: list[dict[str, Any]]) -> None:
        """Hydrate resume captain timeline into the seeded zone (G1/G7). Deep-copied."""
        self._seeded_process = copy.deepcopy(list(steps))
        # Seeded steps already lived in journal — skip re-append on flush.
        self._process_cursor.seed_captain(len(self._seeded_process))

    def seed_run_processes(self, run_map: dict[str, list[dict[str, Any]]]) -> None:
        """Hydrate resume worker timelines into the seeded zone (G1/G7). Deep-copied."""
        self._seeded_run_processes = {
            rid: copy.deepcopy(list(steps)) for rid, steps in run_map.items()
        }
        for rid, steps in self._seeded_run_processes.items():
            self._process_cursor.seed_run(rid, len(steps))

    def raw_process(self) -> list[dict[str, Any]]:
        """Seeded ⊕ live captain steps with **no** structural gate (G1 capture).

        Unlike ``process_timeline()``, a pure prose turn still returns its steps —
        suspension snapshots must not drop pre-pause content/reasoning.
        """
        if not self._seeded_process:
            return list(self._process)
        return [*self._seeded_process, *self._process]

    def raw_run_processes(self) -> dict[str, list[dict[str, Any]]]:
        """Seeded ⊕ live worker step maps with **no** empty-map gate (G1 capture)."""
        return self._merged_run_processes()

    def _merged_run_processes(self) -> dict[str, list[dict[str, Any]]]:
        out: dict[str, list[dict[str, Any]]] = {}
        for rid, steps in self._seeded_run_processes.items():
            if steps:
                out[rid] = list(steps)
        for rid, steps in self._run_processes.items():
            if not steps:
                continue
            prior = out.get(rid)
            out[rid] = [*prior, *steps] if prior else list(steps)
        return out

    def execution_journal(self) -> list[dict[str, Any]] | None:
        has_surface = any(e["type"] in _JOURNAL_SURFACE_TYPES for e in self._journal)
        return self._journal if has_surface else None

    def process_timeline(self) -> list[dict[str, Any]] | None:
        # Persist the timeline whenever it carries STRUCTURE beyond the CEO's own text —
        # a tool, the team graph, or an interaction / 痕迹 marker (checkpoint / ask /
        # plan_review / team_preview / escalation / approval / delegation_authorization).
        # A pure reasoning/content turn needs none (the content scalar IS the answer, and
        # reasoning rides its own column), matching the fold's "tool-less single-agent turn
        # → no process" so live / reload / golden stay aligned.
        # Gate scans seeded⊕live; unseeded path returns the live list by reference
        # (status-quo identity for callers that mutate / compare).
        if self._seeded_process:
            merged = [*self._seeded_process, *self._process]
            structural = any(s.get("kind") not in ("reasoning", "content") for s in merged)
            return merged if structural else None
        structural = any(s.get("kind") not in ("reasoning", "content") for s in self._process)
        return self._process if structural else None

    def run_process_timelines(self) -> dict[str, list[dict[str, Any]]] | None:
        """Per-run ProcessStep[] maps for worker detail timelines (对称 CEO process).

        Persist any non-empty run timeline so reload keeps true interleaving (tools
        between thinking/output). Empty map → None (no field on the runs payload).
        When seeded, returns seeded⊕live merge; otherwise the live map only (status quo).
        """
        if self._seeded_run_processes:
            out = self._merged_run_processes()
            return out or None
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

        Live zone only — seeded pre-pause content must not re-enter salvage joins (G8).
        """
        return "".join(
            step.get("text", "") for step in self._process if step.get("kind") == "content"
        )

    def streamed_reasoning(self) -> str:
        """CEO thinking text accumulated so far (live ``reasoning`` steps only)."""
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
