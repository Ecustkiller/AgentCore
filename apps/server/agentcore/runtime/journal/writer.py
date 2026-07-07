"""Write-through turn journal persistence (append-on-emit)."""

from __future__ import annotations

import asyncio
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
    """Append-on-emit journal writer for one turn."""

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
        self._pending: list[asyncio.Task[None]] = []

    @property
    def degraded(self) -> bool:
        return self._degraded

    def schedule_append(self, entry: dict[str, Any]) -> asyncio.Future[None] | None:
        """Queue one fact for durable append; returns a Future completed when written."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return None
        future: asyncio.Future[None] = loop.create_future()
        task = loop.create_task(self._append(entry, future))
        self._pending.append(task)
        task.add_done_callback(lambda t: self._pending.remove(t) if t in self._pending else None)
        return future

    async def _append(self, entry: dict[str, Any], future: asyncio.Future[None]) -> None:
        seq = self._next_seq
        self._next_seq += 1
        try:
            from agentcore.db.base import async_session_factory
            from agentcore.db.repositories import TurnJournalRepository

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
            from agentcore.runtime.audit.hooks import on_journal_fact_appended

            on_journal_fact_appended(entry)
        if not future.done():
            future.set_result(None)

    async def flush(self) -> None:
        """Wait for all in-flight append tasks (e.g. before pause frame save)."""
        if self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)
