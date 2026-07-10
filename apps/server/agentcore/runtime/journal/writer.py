"""Write-through turn journal persistence (append-on-emit)."""

from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from contextvars import ContextVar
from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# Bound for the duration of a turn (fresh or resumed). When set, every
# :func:`~agentcore.runtime.facts.record_turn_fact` schedules a durable append
# before the matching SSE event is delivered.
current_journal_writer: ContextVar[TurnJournalWriter | None] = ContextVar(
    "current_journal_writer", default=None
)


class TurnJournalWriter:
    """Append-on-emit journal writer for one turn.

    Facts are persisted through a SINGLE serial write-behind consumer: each scheduled
    fact is queued and drained one at a time over one DB connection, rather than fanning
    out a task-(and-connection-)per-fact. A wide parallel delegation — many workers each
    emitting facts concurrently — could otherwise storm the pool with a fact-per-connection
    burst; the prior fan-out model exhausted / leaked connections under that load (asyncpg
    ``connection_lost`` + non-checked-in-connection GC noise). Ordering, per-fact durability
    (its own commit), best-effort degradation, the post-append hook, and the per-fact Future
    the SSE barrier awaits are all preserved — only the concurrency is bounded to one in-flight
    write. ``seq`` is explicit on every row, so serial writes stay correctly ordered.

    The turn owner MUST ``await flush()`` at turn end (before resetting the context var) so the
    tail of queued facts is drained rather than abandoned mid-flight — an abandoned in-flight
    write is precisely what produced the connection-termination noise (the GC reclaiming a
    still-checked-out connection whose task was never awaited).
    """

    def __init__(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        trace_id: str | None,
        initial_seq: int = 0,
    ) -> None:
        self.turn_id = turn_id
        self.conversation_id = conversation_id
        self.trace_id = trace_id
        self._next_seq = initial_seq
        self._degraded = False
        self._sealed = False
        self._buffer: deque[tuple[int, dict[str, Any], asyncio.Future[None]]] = deque()
        self._drain_task: asyncio.Task[None] | None = None

    @property
    def degraded(self) -> bool:
        return self._degraded

    @property
    def sealed(self) -> bool:
        """True after a durable pause save — further appends are no-ops."""
        return self._sealed

    @property
    def next_seq(self) -> int:
        """Next ``seq`` that would be assigned (also the resume ``initial_seq`` seed)."""
        return self._next_seq

    def schedule_append(self, entry: dict[str, Any]) -> asyncio.Future[None] | None:
        """Queue one fact for durable append; returns a Future completed when written.

        ``seq`` is assigned here so enqueue order == emit order == the turn's fact-stream
        order; a single drain consumer then writes the queue serially. Returns ``None`` when
        called outside a running loop (standalone engine calls / tests) — recording degrades
        to a no-op, exactly as before. Also returns ``None`` when :meth:`seal` has closed
        the writer at a durable pause (post-save emits must not diverge snapshot vs DB).
        """
        if self._sealed:
            return None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        future: asyncio.Future[None] = loop.create_future()
        seq = self._next_seq
        self._next_seq += 1
        self._buffer.append((seq, entry, future))
        if self._drain_task is None or self._drain_task.done():
            self._drain_task = loop.create_task(self._drain())
        return future

    async def _drain(self) -> None:
        """Serially write every queued fact, one connection at a time.

        Each fact keeps its own session + commit (per-fact durability + failure isolation,
        unchanged); only the fan-out is gone. A write failure degrades the turn (best-effort:
        journal persistence must never break the turn) but STILL resolves the Future so the SSE
        barrier can never hang, and the drain continues with the rest.
        """
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import TurnJournalRepository
        from agentcore.runtime.audit.hooks import on_journal_fact_appended

        while self._buffer:
            seq, entry, future = self._buffer.popleft()
            try:
                async with async_session_factory() as db:
                    await TurnJournalRepository(db).append(
                        turn_id=self.turn_id,
                        seq=seq,
                        conversation_id=self.conversation_id,
                        trace_id=self.trace_id,
                        entry=entry,
                    )
            except Exception as e:  # noqa: BLE001 — journal persistence must never break the turn
                self._degraded = True
                logger.warning(
                    "journal.append_failed",
                    turn_id=self.turn_id,
                    seq=seq,
                    kind=entry.get("kind"),
                    error=str(e),
                )
            else:
                on_journal_fact_appended(entry)
            finally:
                if not future.done():
                    future.set_result(None)

    async def flush(self) -> None:
        """Wait for all queued appends to be written (turn-end / pre-pause drain).

        Loops so a fact enqueued after the current drain finished — which starts a fresh drain
        task — is awaited too; returns only once the queue is empty and no drain is in flight.
        """
        while self._drain_task is not None and not self._drain_task.done():
            with contextlib.suppress(Exception):
                await self._drain_task
        # Defensive: no live drainer but the buffer is non-empty (never expected — every
        # enqueue starts one). Drain inline; safe because nothing else is consuming now.
        if self._buffer:
            await self._drain()

    async def seal(self) -> None:
        """Hard-stop durable appends after a successful pause save.

        Flushes any in-flight queue, then marks the writer sealed so later
        :meth:`schedule_append` / ``record_turn_fact`` calls no-op for durability.
        In-memory EventSink / fact-log updates still proceed independently — only the
        DB write-through is closed. Idempotent.
        """
        if self._sealed:
            return
        await self.flush()
        self._sealed = True
        logger.info(
            "journal.sealed_at_pause",
            turn_id=self.turn_id,
            next_seq=self._next_seq,
        )
