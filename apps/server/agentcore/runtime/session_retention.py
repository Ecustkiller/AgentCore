"""7-day idle TTL sweep for persisted 留人 sessions (乙 热修 P3).

Mirrors workspace retention: a periodic backstop that deletes ``run_sessions`` rows
untouched within the window, so the durable roster does not grow without bound. A
row's ``updated_at`` advances on each revision, so an actively-revised session stays
alive; one left alone for the retention window is pruned (a later 唤回 then 回落甲).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import RunSessionRepository

logger = get_logger(__name__)


async def run_session_retention_sweep() -> int:
    """Delete every session idle past the retention window; return rows removed.

    Batched (``session_roster_sweep_batch_limit`` per round) so a large backlog is
    cleared without one huge transaction."""
    if not settings.session_roster_persist_enabled:
        return 0
    before = datetime.now() - timedelta(days=settings.session_roster_retention_days)
    limit = settings.session_roster_sweep_batch_limit
    total = 0
    async with async_session_factory() as session:
        repo = RunSessionRepository(session)
        while True:
            deleted = await repo.delete_stale(before=before, limit=limit)
            total += deleted
            if deleted < limit:
                break
    if total:
        logger.info("session.retention_swept", deleted=total)
    return total


async def session_retention_loop() -> None:
    """Run :func:`run_session_retention_sweep` forever on the configured interval.
    Cancelled cleanly on shutdown."""
    interval = settings.session_roster_sweep_interval_seconds
    while True:
        try:
            await run_session_retention_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed sweep must not kill the loop
            # Best-effort backstop, logged on ONE line (no traceback) so a recurring
            # transient can't flood the AI logs. A schema fault (e.g. run_sessions
            # missing = pending migration) is persistent, not transient — escalate it
            # to error so a watchdog catches the whole sweep silently failing forever.
            log = logger.error if is_schema_error(e) else logger.warning
            log("session.retention_failed", error=str(e))
        await asyncio.sleep(interval)
