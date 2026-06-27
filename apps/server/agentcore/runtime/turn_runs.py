"""In-process registry of active chat-turn runs (执行与请求解耦 C1 · slice 1a).

Background — why this exists
---------------------------
A chat turn used to be bound to its SSE request: the route spawned the pipeline as
a ``producer`` task and the SSE layer cancelled it the instant the client
disconnected. That coupling lost the most painful real case (实测案例复盘 案例 1: a
7-minute 法律论文 turn dropped its connection and the whole delivery was thrown
away). To decouple execution from the request, the turn now runs as a *detached*
task tracked here, keyed by ``conversation_id``; the SSE layer only ATTACHES to it.

Resulting lifecycle
-------------------
- **client disconnect** → the SSE stream detaches, but the run keeps going and
  persists its reply in the background (断线不再丢交付).
- **explicit stop** (``POST .../stop``) → :meth:`stop` cancels the run task, which
  unwinds through the turn's existing ``CancelledError`` salvage (finished team
  work is kept as an incomplete message).
- **normal completion** → the task's done-callback drops it from the registry.

Posture
-------
State is in-process — the same single-worker stance approvals / interaction /
locks already take (see ``approvals.py``). A process restart drops in-flight runs
(they simply end, like handoff jobs today); a durable cross-process queue
(C2 / Redis) is the 放量-time successor. The registry also holds a strong reference
to each task, so a detached run is never garbage-collected mid-flight (the role
``_background_tasks`` plays for handoff jobs in ``conversation/service.py``).
"""

import asyncio
from dataclasses import dataclass

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.runtime.events import EventSink

logger = get_logger(__name__)


@dataclass
class TurnRun:
    """A detached chat-turn task and its sink, tracked while it runs."""

    run_id: str
    conversation_id: str
    task: asyncio.Task
    sink: EventSink


class TurnRunRegistry:
    """Tracks the active detached run per conversation (one active run each).

    Turns for one conversation are serialized client-side and by the folder-level
    ``workspace_lock``, so one active run per ``conversation_id`` is the model. A
    rare overlap (e.g. a regenerate fired before the prior run cleared) overwrites
    the slot and is logged — the older task still runs to completion / persistence,
    it just can no longer be addressed by :meth:`stop`.
    """

    def __init__(self) -> None:
        self._runs: dict[str, TurnRun] = {}

    def register(self, *, conversation_id: str, task: asyncio.Task, sink: EventSink) -> str:
        """Track ``task`` as the conversation's active run; returns its ``run_id``.

        Installs a done-callback that drops the run from the registry when it ends —
        only if it is still the registered one, so a newer run is never evicted by an
        older task finishing.
        """
        run_id = new_id()
        existing = self._runs.get(conversation_id)
        if existing is not None and not existing.task.done():
            logger.warning(
                "turn_run.overlap",
                conversation_id=conversation_id,
                existing_run_id=existing.run_id,
                new_run_id=run_id,
            )
        self._runs[conversation_id] = TurnRun(
            run_id=run_id,
            conversation_id=conversation_id,
            task=task,
            sink=sink,
        )
        task.add_done_callback(lambda _t: self._discard(conversation_id, run_id))
        return run_id

    def _discard(self, conversation_id: str, run_id: str) -> None:
        current = self._runs.get(conversation_id)
        if current is not None and current.run_id == run_id:
            del self._runs[conversation_id]

    def get(self, conversation_id: str) -> TurnRun | None:
        """The conversation's active run, or ``None`` if nothing is running."""
        return self._runs.get(conversation_id)

    def stop(self, conversation_id: str) -> bool:
        """Cancel the conversation's active run (explicit user 停止).

        Returns ``True`` if a live run was found and signalled, ``False`` when
        nothing is running (already finished / never started) — so the endpoint is
        idempotent. Cancelling drives the turn through its ``CancelledError`` salvage
        (finished work kept as an incomplete message), then the done-callback clears
        the slot.
        """
        run = self._runs.get(conversation_id)
        if run is None or run.task.done():
            return False
        run.task.cancel()
        logger.info("turn_run.stop", conversation_id=conversation_id, run_id=run.run_id)
        return True

    async def stop_and_drain(self, conversation_id: str, *, timeout: float = 10.0) -> bool:
        """Cancel the conversation's live run AND await its unwind — durable-resume preflight.

        Durable ``POST .../resume`` takes a paused turn over from its persisted frame. A
        disconnect does NOT end the in-process run (执行与请求解耦), so it can still be sitting
        blocked on its ``ask_user`` / ``plan_review`` interaction, holding the folder
        ``workspace_lock`` until ``checkpoint_timeout`` (default 600s). Spawning the resume
        run on top of that would (1) deadlock on that lock and (2) — once the old run times
        out — continue the SAME turn a second time. So tear it down first: ``cancel`` raises
        ``CancelledError`` through the suspend point, which leaves the durable frame intact
        and releases the lock; we then await the unwind (bounded, so a wedged task can't hang
        the request) before the resume run takes the lock. ``stop`` is the fire-and-forget
        sibling (user 「停止」); this one waits because the caller needs the lock freed next.
        Returns ``True`` if a live run was found and drained.
        """
        run = self._runs.get(conversation_id)
        if run is None or run.task.done():
            return False
        run.task.cancel()
        logger.info("turn_run.stop", conversation_id=conversation_id, run_id=run.run_id)
        # ``asyncio.wait`` never re-raises the task's (CancelledError) result; a timeout just
        # means it is still unwinding, in which case the resume run briefly blocks on the lock.
        await asyncio.wait({run.task}, timeout=timeout)
        return True


# Module-level singleton (single-worker posture, as approvals / interaction).
turn_runs = TurnRunRegistry()
