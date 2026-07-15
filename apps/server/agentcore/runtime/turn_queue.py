"""Conversation-level turn queue (同会话并行发消息 → 显式串行).

When a turn is already in-flight for a conversation, subsequent ``POST …/messages``
requests enqueue here instead of overlapping ``turn_runs`` slots / dual sinks.
The active turn's done-callback drains the queue FIFO and starts the next turn.

Process-local (same posture as :mod:`agentcore.runtime.turn_runs`). Restart drops
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
    requires_tools: bool = False
    x_client_platform: str | None = None
    user_id: str = ""
    # Preflight credentials resolved at enqueue time (billing gate already passed).
    llm_credentials: Any = None
    llm_supports_tools: bool | None = None


@dataclass(frozen=True, slots=True)
class QueueStatus:
    """Visible queue state returned on the enqueue API response."""

    queue_id: str
    position: int  # 1-based index in the conversation queue
    queue_depth: int  # total pending after this enqueue


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

    def depth(self, conversation_id: str) -> int:
        return len(self._queues.get(conversation_id) or ())

    def clear(self, conversation_id: str) -> int:
        """Drop all pending turns (e.g. conversation deleted). Returns count dropped."""
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
        self._drain_scheduled.add(conversation_id)
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            self._drain_scheduled.discard(conversation_id)
            return
        loop.call_soon(lambda: asyncio.create_task(self._drain(conversation_id)))

    async def _drain(self, conversation_id: str) -> None:
        self._drain_scheduled.discard(conversation_id)
        from agentcore.runtime.turn_runs import turn_runs

        # If another turn already claimed the slot, wait for its done-callback.
        existing = turn_runs.get(conversation_id)
        if existing is not None and not existing.task.done():
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


async def _start_queued_turn(conversation_id: str, item: QueuedTurn) -> None:
    """Spawn the detached turn the same way ``send_message`` does (no SSE attach)."""
    import asyncio

    from agentcore.conversation.service import stream_chat
    from agentcore.runtime.events import EventSink
    from agentcore.runtime.turn_runs import turn_runs

    sink = EventSink()
    # Detached: no client is attached to this sink (enqueue returned 202). The turn
    # still persists; the client can re-attach via GET …/stream or reload messages.
    sink.detach()

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
        )
    )
    turn_runs.register(conversation_id=conversation_id, task=task, sink=sink)


def new_queued_turn(
    *,
    content: str,
    user_id: str,
    attachments: list[dict[str, Any]] | None = None,
    requires_tools: bool = False,
    x_client_platform: str | None = None,
    llm_credentials: Any = None,
    llm_supports_tools: bool | None = None,
) -> QueuedTurn:
    return QueuedTurn(
        queue_id=new_id(),
        content=content,
        attachments=list(attachments or []),
        requires_tools=requires_tools,
        x_client_platform=x_client_platform,
        user_id=user_id,
        llm_credentials=llm_credentials,
        llm_supports_tools=llm_supports_tools,
    )


# Module-level singleton (single-worker posture, as turn_runs).
turn_queue = TurnQueue()
