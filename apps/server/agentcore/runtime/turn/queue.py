"""Conversation-level turn queue (同会话并行发消息 → 显式串行).

When a turn is already in-flight for a conversation, subsequent ``POST …/messages``
requests enqueue here instead of overlapping ``turn_runs`` slots / dual sinks.
The active turn's done-callback drains the queue FIFO and starts the next turn —
unless a cold-resume deferred waiter owns the next slot (see ``turn.runs``;
deferred finishes first, then FIFO).

发送即有流 (D9): the enqueueing POST keeps an SSE open — it immediately emits
``turn_queued``, then when drain starts that entry the **same connection** becomes
the primary observer of the new turn's sink (reuse attach / detach policy). Drain
emits ``turn_queue_started`` as that sink's first frame (before ``message_start``).
If the waiting client disconnects mid-queue, the turn still starts detached (existing
attach/recovery path); no new mechanism.

Process-local (same posture as :mod:`.runs`). Restart drops
the queue; durable recovery of queued content is out of scope for this slice.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id

logger = get_logger(__name__)


@dataclass(slots=True)
class QueuedTurn:
    """One user message waiting for the conversation's in-flight turn to finish."""

    queue_id: str
    content: str
    attachments: list[dict[str, Any]] = field(default_factory=list)
    agent_mentions: list[dict[str, Any]] = field(default_factory=list)
    requires_tools: bool = False
    x_client_platform: str | None = None
    user_id: str = ""
    # Preflight credentials resolved at enqueue time (billing gate already passed).
    llm_credentials: Any = None
    llm_supports_tools: bool | None = None
    # Set when this entry was promoted from a user interjection (协调升队 /
    # 经典 steer leftover). Plain ``delivery=queue`` enqueues leave it None.
    interjection_id: str | None = None
    # Set by the enqueueing SSE when it opens: drain resolves with the live turn sink
    # so the waiting connection can continue on the same stream. None → no waiter
    # (tests / detached-only start) → sink starts detached as before.
    started: asyncio.Future[Any] | None = field(default=None, repr=False)


@dataclass(frozen=True, slots=True)
class QueueStatus:
    """Visible queue state mirrored on the ``turn_queued`` SSE payload."""

    queue_id: str
    position: int  # 1-based index in the conversation queue
    queue_depth: int  # total pending after this enqueue


def _try_emit_live_turn_queued(
    *,
    conversation_id: str,
    queue_id: str,
    position: int,
    queue_depth: int,
    degraded_from: str | None = None,
) -> bool:
    """Emit ``turn_queued`` on the live turn sink when present (multi-client UI).

    No live sink → log only; never fabricate a broadcast (same posture as cancel).
    """
    from agentcore.runtime.events import turn_queued

    from .runs import turn_runs

    run = turn_runs.get(conversation_id)
    if run is None or run.task.done():
        logger.info(
            "turn_queue.enqueued_no_live_sink",
            conversation_id=conversation_id,
            queue_id=queue_id,
            position=position,
            queue_depth=queue_depth,
            degraded_from=degraded_from,
        )
        return False
    run.sink.emit(
        turn_queued(
            queue_id=queue_id,
            position=position,
            queue_depth=queue_depth,
            conversation_id=conversation_id,
            degraded_from=degraded_from,
        )
    )
    return True


class TurnQueue:
    """FIFO pending turns keyed by ``conversation_id``."""

    def __init__(self) -> None:
        self._queues: dict[str, deque[QueuedTurn]] = defaultdict(deque)
        self._drain_scheduled: set[str] = set()

    def enqueue(self, conversation_id: str, item: QueuedTurn) -> QueueStatus:
        q = self._queues[conversation_id]
        q.append(item)
        depth = len(q)
        logger.info(
            "turn_queue.enqueued",
            conversation_id=conversation_id,
            queue_id=item.queue_id,
            position=depth,
            queue_depth=depth,
        )
        return QueueStatus(queue_id=item.queue_id, position=depth, queue_depth=depth)

    def enqueue_and_ensure_drain(
        self,
        conversation_id: str,
        item: QueuedTurn,
        *,
        emit_live_queued: bool = False,
        degraded_from: str | None = None,
    ) -> QueueStatus:
        """Enqueue, then close the「宿主已结束、drain 已 no-op」race window.

        The send route may await between its in-flight check and this enqueue (e.g.
        协调 fall-through 的附件落盘). If the host turn finished inside that window, its
        done-callback ran ``schedule_drain`` against a then-empty queue and disarmed —
        nobody would ever start this item (排队项搁浅、等待端卡 await). Re-checking the
        slot AFTER the append closes the window: either a turn is still live (its
        done-callback will drain), or the slot is free/finished and we arm the drain
        ourselves. ``schedule_drain`` is idempotent and ``_drain`` re-checks the slot,
        so double-arming is harmless.

        ``emit_live_queued=True`` (协调升队等): also emit ``turn_queued`` on the live
        turn sink so the bar is visible/cancellable for multi-client. Classic POST
        waiting SSE and leftover ``degraded_from=steer`` honesty keep their own emit
        paths (pass False; leftover still calls its dedicated helper).
        """
        status = self.enqueue(conversation_id, item)
        if emit_live_queued:
            _try_emit_live_turn_queued(
                conversation_id=conversation_id,
                queue_id=status.queue_id,
                position=status.position,
                queue_depth=status.queue_depth,
                degraded_from=degraded_from,
            )
        from .runs import turn_runs

        existing = turn_runs.get(conversation_id)
        if existing is None or existing.task.done():
            self.schedule_drain(conversation_id)
        return status

    def depth(self, conversation_id: str) -> int:
        return len(self._queues.get(conversation_id) or ())

    def list_pending(self, conversation_id: str) -> list[QueuedTurn]:
        """FIFO snapshot of pending turns (process-local; empty after restart)."""
        q = self._queues.get(conversation_id)
        if not q:
            return []
        return list(q)

    def clear(self, conversation_id: str) -> int:
        """Drop all pending turns (e.g. conversation deleted). Returns count dropped.

        Not a Stop side-effect — ``POST …/stop`` must leave queued items intact.
        """
        q = self._queues.pop(conversation_id, None)
        self._drain_scheduled.discard(conversation_id)
        n = len(q) if q else 0
        if n:
            logger.info(
                "turn_queue.cleared",
                conversation_id=conversation_id,
                dropped=n,
            )
        return n

    def cancel(self, conversation_id: str, queue_id: str) -> QueuedTurn | None:
        """Remove one pending turn by ``queue_id`` before drain. Returns the item or None.

        Already-started / unknown id → None (route maps to 404). Does not affect
        the in-flight turn or other queue entries.
        """
        q = self._queues.get(conversation_id)
        if not q:
            return None
        for idx, item in enumerate(q):
            if item.queue_id != queue_id:
                continue
            del q[idx]
            if not q:
                self._queues.pop(conversation_id, None)
            logger.info(
                "turn_queue.cancelled",
                conversation_id=conversation_id,
                queue_id=queue_id,
                remaining=len(q),
            )
            return item
        return None

    def pop_next(self, conversation_id: str) -> QueuedTurn | None:
        q = self._queues.get(conversation_id)
        if not q:
            self._queues.pop(conversation_id, None)
            return None
        item = q.popleft()
        if not q:
            self._queues.pop(conversation_id, None)
        return item

    def schedule_drain(self, conversation_id: str) -> None:
        """Arm a one-shot drain after the active turn ends (idempotent per idle gap)."""
        if conversation_id in self._drain_scheduled:
            return
        if not self._queues.get(conversation_id):
            return
        from .runs import turn_runs

        # Cold resume deferred owns the next free slot — do not steal it for FIFO.
        if turn_runs.has_resume_deferred(conversation_id):
            return
        self._drain_scheduled.add(conversation_id)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._drain_scheduled.discard(conversation_id)
            return
        loop.call_soon(lambda: asyncio.create_task(self._drain(conversation_id)))

    async def _drain(self, conversation_id: str) -> None:
        self._drain_scheduled.discard(conversation_id)
        from .runs import turn_runs

        # If another turn already claimed the slot, wait for its done-callback.
        existing = turn_runs.get(conversation_id)
        if existing is not None and not existing.task.done():
            return
        # Deferred cold resume has priority over FIFO.
        if turn_runs.has_resume_deferred(conversation_id):
            return

        item = self.pop_next(conversation_id)
        if item is None:
            return

        logger.info(
            "turn_queue.starting",
            conversation_id=conversation_id,
            queue_id=item.queue_id,
            remaining=self.depth(conversation_id),
        )
        try:
            await _start_queued_turn(conversation_id, item)
        except Exception:  # noqa: BLE001 — never strand the rest of the queue
            logger.exception(
                "turn_queue.start_failed",
                conversation_id=conversation_id,
                queue_id=item.queue_id,
            )
            # Continue draining remaining items.
            self.schedule_drain(conversation_id)


def _waiter_still_alive(item: QueuedTurn) -> bool:
    """True when the enqueueing SSE is still waiting to receive the live sink."""
    fut = item.started
    return fut is not None and not fut.done()


async def _start_queued_turn(conversation_id: str, item: QueuedTurn) -> None:
    """Spawn the turn; hand the sink to a waiting SSE if still connected.

    Emits ``turn_queue_started`` as the new sink's first frame (before ``stream_chat``).
    """
    import asyncio

    from agentcore.conversation.service import stream_chat
    from agentcore.runtime.events import EventSink, turn_queue_started

    from .runs import turn_runs

    sink = EventSink()
    remaining_depth = turn_queue.depth(conversation_id)
    sink.emit(
        turn_queue_started(
            queue_id=item.queue_id,
            conversation_id=conversation_id,
            remaining_depth=remaining_depth,
        )
    )
    if _waiter_still_alive(item):
        # Waiting POST is still open — it becomes the primary SSE consumer (no detach).
        assert item.started is not None
        item.started.set_result(sink)
    else:
        # No waiter / disconnected mid-queue → detached (attach / recovery as before).
        sink.detach(reason="queue_drain_no_waiter")

    task = asyncio.create_task(
        stream_chat(
            conversation_id=conversation_id,
            user_message=item.content,
            user_id=item.user_id,
            sink=sink,
            attachments=item.attachments,
            llm_credentials=item.llm_credentials,
            llm_supports_tools=item.llm_supports_tools,
            x_client_platform=item.x_client_platform,
            agent_mentions=item.agent_mentions,
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)


def new_queued_turn(
    *,
    content: str,
    user_id: str,
    attachments: list[dict[str, Any]] | None = None,
    agent_mentions: list[dict[str, Any]] | None = None,
    requires_tools: bool = False,
    x_client_platform: str | None = None,
    llm_credentials: Any = None,
    llm_supports_tools: bool | None = None,
    interjection_id: str | None = None,
    started: asyncio.Future[Any] | None = None,
) -> QueuedTurn:
    return QueuedTurn(
        queue_id=new_id(),
        content=content,
        attachments=list(attachments or []),
        agent_mentions=list(agent_mentions or []),
        requires_tools=requires_tools,
        x_client_platform=x_client_platform,
        user_id=user_id,
        llm_credentials=llm_credentials,
        llm_supports_tools=llm_supports_tools,
        interjection_id=interjection_id,
        started=started,
    )


# Module-level singleton (single-worker posture, as turn_runs).
turn_queue = TurnQueue()
