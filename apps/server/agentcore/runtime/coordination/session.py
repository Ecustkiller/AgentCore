"""Coordination session: event queue, budget, timeouts, and durable snapshot.

Root-CEO only (Phase 2+). Lead nesting stays on the blocking path.
"""

from __future__ import annotations

import asyncio
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# Cap CEO LLM rounds spent on intermediate coordination (not counting the final
# all_completed synthesis). Necessary decision points always get a slot; middle
# independent completions may merge into one injection without an LLM call.
DEFAULT_COORDINATION_BUDGET = 8

# Default per-worker wall-clock before a timeout *notification* (CEO decides; no auto-cancel).
# Overridden by plan node ``timeout_ms`` → ``RunPolicy.timeout_s`` when present.
DEFAULT_WORKER_TIMEOUT_S = 120.0

# Registry keyed by root-turn ``execution_id`` (captain + all workers share one id).
# Module-level dict — not a ContextVar holding the session — because ``execute_tools``
# runs each tool under ``asyncio.gather``, which copies the context: a session set
# inside ``delegate`` would be invisible to the parent CEO ``react_loop``. The dict
# is a shared object visible across gather; the key isolates concurrent turns.
# ``current_execution_id`` is set at turn entry (before gather) so the captain wait
# path can resolve without threading execution_id through the whole loop.
_sessions: dict[str, CoordinationSession] = {}
current_execution_id: ContextVar[str | None] = ContextVar(
    "current_execution_id", default=None
)


class CoordinationEventKind(StrEnum):
    WORKER_COMPLETED = "worker_completed"
    NOTE_POSTED = "note_posted"
    ESCALATION = "escalation"
    TIMEOUT = "timeout"
    ALL_COMPLETED = "all_completed"
    BOUNDARY_YIELD = "boundary_yield"


@dataclass(frozen=True, slots=True)
class CoordinationEvent:
    kind: CoordinationEventKind
    payload: dict[str, Any] = field(default_factory=dict)


@dataclass
class CoordinationSnapshot:
    """Durable slice restored on ask_user resume / process restart."""

    execution_id: str
    draft: str = ""
    completed_run_ids: list[str] = field(default_factory=list)
    budget_remaining: int = DEFAULT_COORDINATION_BUDGET
    total_workers: int = 0
    active: bool = True
    cancel_run_ids: list[str] = field(default_factory=list)
    pending_events: list[dict[str, Any]] = field(default_factory=list)
    # D1: blocking escalate awaiting CEO — survives ask_user soft-stop so resume can
    # resolve_escalation (or re-armed workers pick up a stashed answer).
    pending_arbitrations: list[dict[str, Any]] = field(default_factory=list)
    resolved_arbitrations: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "execution_id": self.execution_id,
            "draft": self.draft,
            "completed_run_ids": list(self.completed_run_ids),
            "budget_remaining": self.budget_remaining,
            "total_workers": self.total_workers,
            "active": self.active,
            "cancel_run_ids": list(self.cancel_run_ids),
            "pending_events": list(self.pending_events),
            "pending_arbitrations": list(self.pending_arbitrations),
            "resolved_arbitrations": list(self.resolved_arbitrations),
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> CoordinationSnapshot | None:
        if not data or not isinstance(data, dict):
            return None
        execution_id = str(data.get("execution_id") or "").strip()
        if not execution_id:
            return None
        return cls(
            execution_id=execution_id,
            draft=str(data.get("draft") or ""),
            completed_run_ids=[str(x) for x in (data.get("completed_run_ids") or [])],
            budget_remaining=int(
                data.get("budget_remaining", DEFAULT_COORDINATION_BUDGET)
            ),
            total_workers=int(data.get("total_workers") or 0),
            active=bool(data.get("active", True)),
            cancel_run_ids=[str(x) for x in (data.get("cancel_run_ids") or [])],
            pending_events=list(data.get("pending_events") or []),
            pending_arbitrations=list(data.get("pending_arbitrations") or []),
            resolved_arbitrations=list(data.get("resolved_arbitrations") or []),
        )


def should_enter_coordination(
    *,
    coordinate: bool,
    worker_count: int,
    finalize: bool,
    depth: int,
) -> bool:
    """Gate: ≥2 workers + root CEO + not finalize; opt out with ``coordinate=False``.

    Callers default ``coordinate`` to True when the LLM omits the arg; only an
    explicit false falls back to classic blocking. Solo / nested lead / finalize
    still never enter.

    **Invariant B**: CEO arbitration (``resolve_escalation`` / ``awaiting=ceo``)
    is available iff a coordination session is active. Solo blocking escalate
    therefore hangs on the **user**, never the CEO — otherwise worker↔CEO deadlock
    (CEO blocked inside ``delegate``, worker waiting for ``resolve_escalation``).
    """
    if coordinate is False:
        return False
    if depth != 0:
        return False
    if finalize:
        return False
    return worker_count >= 2


@dataclass
class CoordinationSession:
    """In-process coordination state for one non-blocking delegate batch."""

    execution_id: str
    total_workers: int
    budget_remaining: int = DEFAULT_COORDINATION_BUDGET
    draft: str = ""
    completed_run_ids: set[str] = field(default_factory=set)
    cancel_ids: set[str] = field(default_factory=set)
    active: bool = True
    # True after all_completed has been injected into the CEO window.
    all_completed_injected: bool = False
    # Background WaveScheduler task (owned by drive); None until started.
    drive_task: asyncio.Task[Any] | None = None
    _queue: asyncio.Queue[CoordinationEvent] = field(
        default_factory=asyncio.Queue, repr=False
    )
    # Events already drained but not yet consumed by an LLM round (merge buffer).
    _pending: list[CoordinationEvent] = field(default_factory=list, repr=False)
    # First worker completion always forces a decision point.
    _saw_first_completion: bool = False
    # Per-worker wall-clock timers (notify-only; never auto-cancel).
    _worker_started_at: dict[str, float] = field(default_factory=dict, repr=False)
    _timeout_tasks: dict[str, asyncio.Task[None]] = field(default_factory=dict, repr=False)
    _timeout_notified: set[str] = field(default_factory=set, repr=False)
    # Dedupe escalation injections (live escalate + completion harvest + SCOPE boundary).
    _escalation_keys: set[str] = field(default_factory=set, repr=False)
    # D1: blocking escalate → CEO arbitration. run_id → live bridge metadata.
    pending_arbitrations: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Answers stashed when the live Future is gone (ask_user soft-stop cancelled the worker);
    # re-armed workers pick these up on the next escalate(blocking=true).
    resolved_arbitrations: dict[str, dict[str, Any]] = field(default_factory=dict)

    def register_arbitration(
        self,
        run_id: str,
        *,
        escalation_id: str,
        conversation_id: str,
        question: str = "",
        assumption: str = "",
        kind: str = "normal",
    ) -> None:
        self.pending_arbitrations[run_id] = {
            "run_id": run_id,
            "escalation_id": escalation_id,
            "conversation_id": conversation_id,
            "question": question,
            "assumption": assumption,
            "kind": kind,
        }

    def get_arbitration(self, run_id: str) -> dict[str, Any] | None:
        return self.pending_arbitrations.get(run_id)

    def clear_arbitration(self, run_id: str) -> None:
        self.pending_arbitrations.pop(run_id, None)

    def stash_resolution(
        self,
        run_id: str,
        *,
        answer: str,
        via_user: bool = False,
        escalation_id: str = "",
    ) -> None:
        payload: dict[str, Any] = {
            "run_id": run_id,
            "answer": answer,
            "via_user": via_user,
        }
        if escalation_id:
            payload["escalation_id"] = escalation_id
        elif run_id in self.pending_arbitrations:
            eid = self.pending_arbitrations[run_id].get("escalation_id")
            if eid:
                payload["escalation_id"] = eid
        self.resolved_arbitrations[run_id] = payload
        self.pending_arbitrations.pop(run_id, None)

    def take_stashed_resolution(self, run_id: str) -> dict[str, Any] | None:
        return self.resolved_arbitrations.pop(run_id, None)

    def post(self, event: CoordinationEvent) -> bool:
        """Enqueue ``event``. Returns False when dropped (inactive / escalation dedupe)."""
        if not self.active and event.kind is not CoordinationEventKind.ALL_COMPLETED:
            return False
        if event.kind is CoordinationEventKind.ESCALATION:
            key = (
                f"{event.payload.get('run_id') or ''}|"
                f"{event.payload.get('kind') or ''}|"
                f"{(event.payload.get('question') or event.payload.get('summary') or '')[:120]}"
            )
            if key in self._escalation_keys:
                return False
            self._escalation_keys.add(key)
        self._queue.put_nowait(event)
        logger.debug(
            "coordination.event_posted",
            kind=event.kind.value,
            execution_id=self.execution_id,
        )
        return True

    def mark_worker_completed(self, run_id: str) -> None:
        self.completed_run_ids.add(run_id)
        self.disarm_worker_timeout(run_id)

    def request_cancel(self, run_id: str) -> None:
        self.cancel_ids.add(run_id)

    def arm_worker_timeout(
        self,
        run_id: str,
        *,
        role: str = "",
        timeout_s: float | int | None = None,
    ) -> None:
        """Start a notify-only timer for ``run_id``. Idempotent per run_id."""
        if not self.active or run_id in self.completed_run_ids:
            return
        if run_id in self._timeout_tasks and not self._timeout_tasks[run_id].done():
            return
        threshold = (
            float(timeout_s)
            if timeout_s and float(timeout_s) > 0
            else DEFAULT_WORKER_TIMEOUT_S
        )
        self._worker_started_at[run_id] = time.monotonic()
        self._timeout_notified.discard(run_id)

        async def _fire() -> None:
            try:
                await asyncio.sleep(threshold)
            except asyncio.CancelledError:
                return
            if not self.active or run_id in self.completed_run_ids:
                return
            if run_id in self._timeout_notified:
                return
            self._timeout_notified.add(run_id)
            started = self._worker_started_at.get(run_id)
            elapsed = (time.monotonic() - started) if started is not None else threshold
            status = "running"
            if run_id in self.cancel_ids:
                status = "cancel_requested"
            self.post(
                CoordinationEvent(
                    kind=CoordinationEventKind.TIMEOUT,
                    payload={
                        "run_id": run_id,
                        "role": role or run_id,
                        "elapsed_s": round(elapsed, 1),
                        "threshold_s": threshold,
                        "status": status,
                        "reason": (
                            f"队员已运行约 {round(elapsed)}s（阈值 {int(threshold)}s），"
                            "仍未交付。可继续等、cancel_worker、或 update_synthesis 先出中间合成。"
                        ),
                    },
                )
            )
            logger.info(
                "coordination.worker_timeout",
                run_id=run_id,
                elapsed_s=round(elapsed, 1),
                threshold_s=threshold,
                execution_id=self.execution_id,
            )

        self._timeout_tasks[run_id] = asyncio.create_task(
            _fire(), name=f"coord-timeout-{run_id[:12]}"
        )

    def disarm_worker_timeout(self, run_id: str) -> None:
        task = self._timeout_tasks.pop(run_id, None)
        if task is not None and not task.done():
            task.cancel()
        self._worker_started_at.pop(run_id, None)

    def cancel_all_timeouts(self) -> None:
        for run_id in list(self._timeout_tasks):
            self.disarm_worker_timeout(run_id)

    def cancel_run_ids(self) -> frozenset[str]:
        return frozenset(self.cancel_ids)

    def update_draft(self, draft: str) -> None:
        self.draft = draft

    def consume_budget(self) -> bool:
        """Spend one coordination LLM slot. Returns False when exhausted."""
        if self.budget_remaining <= 0:
            return False
        self.budget_remaining -= 1
        return True

    def is_necessary_decision(self, events: list[CoordinationEvent]) -> bool:
        """Necessary decision points always wake the CEO (even under budget pressure)."""
        for ev in events:
            if ev.kind is CoordinationEventKind.ALL_COMPLETED:
                return True
            if ev.kind is CoordinationEventKind.ESCALATION:
                return True
            if ev.kind is CoordinationEventKind.TIMEOUT and ev.payload.get("run_id"):
                # Per-worker timeout is a decision point; idle-wait nudge (no run_id) is not.
                return True
            if ev.kind is CoordinationEventKind.BOUNDARY_YIELD:
                return True
            if (
                ev.kind is CoordinationEventKind.WORKER_COMPLETED
                and not self._saw_first_completion
            ):
                return True
        return False

    def note_decision_points(self, events: list[CoordinationEvent]) -> None:
        for ev in events:
            if ev.kind is CoordinationEventKind.WORKER_COMPLETED:
                self._saw_first_completion = True

    async def wait_events(
        self,
        *,
        timeout: float | None = None,
        merge_idle: float = 0.05,
    ) -> list[CoordinationEvent]:
        """Wait for at least one event; briefly coalesce follow-ups (cost merge)."""
        if self._pending:
            batch = self._pending
            self._pending = []
            return batch

        try:
            first = await asyncio.wait_for(self._queue.get(), timeout=timeout)
        except TimeoutError:
            return []

        batch = [first]
        # Short coalesce window so independent mid-wave completions can merge.
        deadline = asyncio.get_running_loop().time() + merge_idle
        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                break
            try:
                nxt = await asyncio.wait_for(self._queue.get(), timeout=remaining)
            except TimeoutError:
                break
            batch.append(nxt)
            if nxt.kind is CoordinationEventKind.ALL_COMPLETED:
                break
        return batch

    def drain_nowait(self) -> list[CoordinationEvent]:
        batch = list(self._pending)
        self._pending = []
        while True:
            try:
                batch.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        return batch

    def snapshot(self) -> CoordinationSnapshot:
        pending = [
            {"kind": e.kind.value, "payload": dict(e.payload)}
            for e in (*self._pending, *self._drain_queue_copy())
        ]
        return CoordinationSnapshot(
            execution_id=self.execution_id,
            draft=self.draft,
            completed_run_ids=sorted(self.completed_run_ids),
            budget_remaining=self.budget_remaining,
            total_workers=self.total_workers,
            active=self.active,
            cancel_run_ids=sorted(self.cancel_ids),
            pending_events=pending,
            pending_arbitrations=[
                dict(v) for v in self.pending_arbitrations.values()
            ],
            resolved_arbitrations=[
                dict(v) for v in self.resolved_arbitrations.values()
            ],
        )

    def _drain_queue_copy(self) -> list[CoordinationEvent]:
        """Non-destructive peek is unavailable on Queue — drain into pending."""
        drained: list[CoordinationEvent] = []
        while True:
            try:
                drained.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        self._pending.extend(drained)
        return list(drained)

    @classmethod
    def from_snapshot(cls, snap: CoordinationSnapshot) -> CoordinationSession:
        session = cls(
            execution_id=snap.execution_id,
            total_workers=snap.total_workers,
            budget_remaining=snap.budget_remaining,
            draft=snap.draft,
            completed_run_ids=set(snap.completed_run_ids),
            cancel_ids=set(snap.cancel_run_ids),
            active=snap.active,
        )
        for raw in snap.pending_events:
            kind_raw = str(raw.get("kind") or "")
            try:
                kind = CoordinationEventKind(kind_raw)
            except ValueError:
                continue
            session._pending.append(
                CoordinationEvent(kind=kind, payload=dict(raw.get("payload") or {}))
            )
        for raw in snap.pending_arbitrations:
            rid = str(raw.get("run_id") or "").strip()
            if rid:
                session.pending_arbitrations[rid] = dict(raw)
        for raw in snap.resolved_arbitrations:
            rid = str(raw.get("run_id") or "").strip()
            if rid:
                session.resolved_arbitrations[rid] = dict(raw)
        if snap.completed_run_ids:
            session._saw_first_completion = True
        return session

    def close(self) -> None:
        self.active = False
        self.cancel_all_timeouts()


def active_coordination(execution_id: str | None = None) -> CoordinationSession | None:
    """Look up the coordination session for a turn.

    Prefer an explicit ``execution_id`` (tool contexts). When omitted, resolve via
    the turn-entry :data:`current_execution_id` ContextVar (captain wait path).
    """
    eid = (execution_id or "").strip() or (current_execution_id.get() or "").strip()
    if not eid:
        return None
    return _sessions.get(eid)


def set_active_coordination(session: CoordinationSession | None) -> None:
    """Register ``session`` under its ``execution_id``, or clear when ``None``.

    Also binds :data:`current_execution_id` in the *current* context (tests / settle
    in the captain task). When ``set_active`` runs inside an ``asyncio.gather`` child
    (delegate tool), that ContextVar write stays in the child copy — the parent CEO
    loop relies on the turn-entry binding set before gather.
    """
    if session is None:
        clear_active_coordination()
        return
    eid = (session.execution_id or "").strip()
    if not eid:
        logger.warning("coordination.set_active_missing_execution_id")
        return
    _sessions[eid] = session
    current_execution_id.set(eid)


def clear_active_coordination(
    execution_id: str | None = None,
    _token: object | None = None,
) -> None:
    """Drop one session by ``execution_id``, or the whole registry when omitted.

    ``_token`` kept for call-site compat (ignored). Omitting ``execution_id`` clears
    every entry — used by test teardown. Pass an id to isolate concurrent turns.
    """
    eid = (execution_id or "").strip()
    if eid:
        _sessions.pop(eid, None)
        return
    _sessions.clear()
