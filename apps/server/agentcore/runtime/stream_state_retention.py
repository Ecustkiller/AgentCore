"""7-day idle TTL sweep for leftover ``turn_stream_state`` rows.

Mirrors ``paused_turns`` retention: a periodic backstop that deletes in-flight
stream snapshots untouched within the window. The live path already drops a
row on finalize / salvage / pause, and conversation / message hard-delete
cascade the rest; this sweep only catches the disconnected remainder — a
stream that UPSERTed, never reached a terminal write, and was never deleted
with its message. A row's ``updated_at`` advances on every accepted UPSERT, so
an actively streaming turn stays alive; one left alone for the retention
window is pruned.

This table is not a fact source (``messages`` + ``turn_journal`` are). Pruning
is storage cleanup, not a settlement.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import TurnStreamStateRepository

logger = get_logger(__name__)


async def run_stream_state_retention_sweep() -> int:
    """Delete every stream snapshot idle past the retention window; return rows removed.

    Batched (``turn_stream_state_sweep_batch_limit`` per round) so a large
    backlog is cleared without one huge transaction. The cutoff is tz-aware UTC,
    matching how ``turn_stream_state.updated_at`` is stamped (``datetime.now(UTC)``).
    ``turn_stream_state_retention_days <= 0`` disables the sweep.
    """
    days = settings.turn_stream_state_retention_days
    if days <= 0:
        return 0
    before = datetime.now(UTC) - timedelta(days=days)
    limit = settings.turn_stream_state_sweep_batch_limit
    total = 0
    async with async_session_factory() as session:
        repo = TurnStreamStateRepository(session)
        while True:
            deleted = await repo.delete_stale(before=before, limit=limit)
            total += deleted
            if deleted < limit:
                break
    if total:
        logger.info("stream_state.retention_swept", deleted=total)
    return total


async def stream_state_retention_loop() -> None:
    """Run :func:`run_stream_state_retention_sweep` forever on the configured interval.
    Cancelled cleanly on shutdown."""
    interval = settings.turn_stream_state_sweep_interval_seconds
    while True:
        try:
            await run_stream_state_retention_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed sweep must not kill the loop
            # Best-effort backstop, logged on ONE line (no traceback) so a recurring
            # transient can't flood the AI logs. A schema fault (e.g. turn_stream_state
            # missing = pending migration) is persistent, not transient — escalate it
            # to error so a watchdog catches the whole sweep silently failing forever.
            if is_schema_error(e):
                logger.error("stream_state.retention_failed", error=str(e))
            else:
                logger.warning("stream_state.retention_failed", error=str(e))
        await asyncio.sleep(interval)
