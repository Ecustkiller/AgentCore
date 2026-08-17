"""7-day hard-cap sweep for pending non-blocking questions.

Mirrors the *window* of paused-turn TTL, not the *table*: ``paused_turns`` only
holds abandoned pause frames, and a ``question_posted`` lives on an already-closed
turn's journal — that sweep can never see it (定案 §二·③). This loop scans
``turn_journal`` for ``question_posted`` hosts older than the window, folds, and
visibly discards whatever is still pending.

Not a silent default-proceed (already vetoed). The note is honest system copy,
not CEO 人话 — TTL is the hard cap, not the CEO-discard fault path.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.conversation.pending_questions import pending_question_records
from agentcore.conversation.question_resolve import settle_question_posted
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import TurnJournalRepository

logger = get_logger(__name__)

TTL_DISCARD_NOTE = "超过 7 天未答，已按硬上限作废。不是按默认替你拍板。"


async def run_question_posted_retention_sweep() -> int:
    """Discard pending ``question_posted`` cards older than the retention window.

    Returns how many cards were newly settled this pass. Batched so a backlog
    does not become one huge transaction. Does not touch ``paused_turns``.
    """
    days = settings.question_posted_retention_days
    if days <= 0:
        return 0
    before = datetime.now(UTC) - timedelta(days=days)
    limit = settings.question_posted_sweep_batch_limit
    settled = 0
    async with async_session_factory() as session:
        repo = TurnJournalRepository(session)
        hosts = await repo.list_question_posted_hosts(
            posted_before=before,
            limit=limit,
        )
        if not hosts:
            return 0
        journals = await repo.load_map([turn_id for _cid, turn_id in hosts])
    for conversation_id, turn_id in hosts:
        for rec in pending_question_records(journals.get(turn_id) or []):
            try:
                outcome = await settle_question_posted(
                    conversation_id=conversation_id,
                    ask_id=rec.id,
                    status="discarded",
                    note=TTL_DISCARD_NOTE,
                )
            except Exception as exc:  # noqa: BLE001 — one card must not abort the sweep
                logger.warning(
                    "question_posted.retention_settle_failed",
                    conversation_id=conversation_id,
                    turn_id=turn_id,
                    ask_id=rec.id,
                    error=str(exc),
                )
                continue
            if outcome == "settled":
                settled += 1
    if settled:
        logger.info("question_posted.retention_swept", settled=settled)
    return settled


async def question_posted_retention_loop() -> None:
    """Run :func:`run_question_posted_retention_sweep` forever on the configured interval."""
    interval = settings.question_posted_sweep_interval_seconds
    while True:
        try:
            await run_question_posted_retention_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed sweep must not kill the loop
            # Best-effort backstop. A schema fault (pending migration) is persistent
            # — escalate to error so a watchdog catches the sweep silently failing.
            if is_schema_error(e):
                logger.error("question_posted.retention_failed", error=str(e))
            else:
                logger.warning("question_posted.retention_failed", error=str(e))
        await asyncio.sleep(interval)
