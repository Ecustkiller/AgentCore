"""Startup + periodic sweeper for expired RUNNING turn leases.

When a process dies mid-turn, its lease heartbeat stops. This loop claims expired
leases and routes each through :func:`agentcore.runtime.recover.recover_turn` so
unfinished DAG nodes redrive from the journal projection (completed nodes skipped).

Paused turns are owned by ``paused_turns`` (not leases) — a lease that coexists with
a paused frame is released without redrive. Terminal journals (``turn_end``) likewise
drop the stale lease.

No-DAG mid-flight turns (pure chat crash) are salvaged from ``turn_stream_state``
(流式回复持久化 §3.4) instead of being skipped.
"""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.conversation.store.merge import MESSAGE_STATUS_INCOMPLETE, pick_monotonic_content
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import MessageRepository, PausedTurnRepository, TurnJournalRepository
from agentcore.runtime.events import FinishReason
from agentcore.runtime.events.stream_checkpointer import (
    CHANNEL_CAPTAIN_CONTENT,
    CHANNEL_CAPTAIN_REASONING,
)
from agentcore.runtime.journal import journal_entries_from_display_runs, persist_turn_journal
from agentcore.runtime.journal.entries import KIND_TURN_END
from agentcore.runtime.leases.repo import TurnLeaseRepository
from agentcore.runtime.leases.service import lease_owner_id
from agentcore.runtime.turn_state import TurnState

logger = get_logger(__name__)

_INTERRUPTED_NOTE = "\n\n（已中断，可重试）"


def _journal_has_turn_end(entries: list[dict]) -> bool:
    return any((e.get("kind") or "") == KIND_TURN_END for e in entries)


async def salvage_no_dag_turn(
    *,
    message_id: str,
    conversation_id: str,
    trace_id: str | None = None,
) -> bool:
    """Close a crashed no-DAG turn from stream_state (incomplete + turn_end interrupted).

    Returns ``True`` when a salvage write was attempted successfully.
    """
    from agentcore.conversation.store import get_cloud_store

    store = get_cloud_store()
    segments = await store.list_stream_segments(turn_id=message_id)
    by_ch = {s["channel"]: s.get("text") or "" for s in segments}
    seg_content = by_ch.get(CHANNEL_CAPTAIN_CONTENT) or ""
    seg_reasoning = by_ch.get(CHANNEL_CAPTAIN_REASONING) or ""

    async with async_session_factory() as session:
        existing = await MessageRepository(session).get_by_id(
            message_id, conversation_id=conversation_id
        )
        existing_content = existing.content if existing else None
        existing_reasoning = existing.reasoning_content if existing else None
        content = pick_monotonic_content(existing_content, seg_content)
        reasoning = pick_monotonic_content(existing_reasoning, seg_reasoning)
        body = (
            f"{content.rstrip()}{_INTERRUPTED_NOTE}" if content.strip() else "（已中断，可重试）"
        )
        await MessageRepository(session).upsert_assistant(
            conversation_id=conversation_id,
            message_id=message_id,
            content=body,
            reasoning_content=reasoning or None,
            trace_id=trace_id or (existing.trace_id if existing else None),
            metadata={
                "status": MESSAGE_STATUS_INCOMPLETE,
                "incomplete": True,
                "finish_reason": FinishReason.INTERRUPTED.value,
            },
            merge=True,
        )
        await persist_turn_journal(
            session,
            message_id=message_id,
            conversation_id=conversation_id,
            trace_id=trace_id or (existing.trace_id if existing else None),
            entries=journal_entries_from_display_runs(
                {"finish_reason": FinishReason.INTERRUPTED.value}
            ),
        )

    with contextlib.suppress(Exception):
        await store.clear_stream_segments(turn_id=message_id)
    logger.info(
        "turn_lease.sweep_salvage_no_dag",
        message_id=message_id,
        conversation_id=conversation_id,
        content_chars=len(content),
        reasoning_chars=len(reasoning or ""),
    )
    return True


async def run_turn_lease_sweep() -> int:
    """Claim expired leases and kick recover; return number of recoveries started."""
    if not settings.turn_lease_enabled:
        return 0
    before = datetime.now(UTC) - timedelta(seconds=settings.turn_lease_ttl_seconds)
    limit = settings.turn_lease_sweep_batch_limit
    owner = lease_owner_id()
    started = 0

    async with async_session_factory() as session:
        repo = TurnLeaseRepository(session)
        expired = list(await repo.list_expired(before=before, limit=limit))

    for row in expired:
        async with async_session_factory() as session:
            claimed = await TurnLeaseRepository(session).claim_expired(
                row.message_id,
                new_owner_id=owner,
                before=before,
                phase="recovering",
            )
        if claimed is None:
            continue

        # Paused frame owns continuation — drop stale RUNNING lease.
        async with async_session_factory() as session:
            paused = await PausedTurnRepository(session).get(claimed.message_id)
            if paused is not None:
                await TurnLeaseRepository(session).release(claimed.message_id)
                logger.info(
                    "turn_lease.sweep_skip_paused",
                    message_id=claimed.message_id,
                )
                continue

            entries = await TurnJournalRepository(session).load_owned(
                claimed.message_id, claimed.conversation_id
            )

        if entries and _journal_has_turn_end(entries):
            async with async_session_factory() as session:
                await TurnLeaseRepository(session).release(claimed.message_id)
            logger.info(
                "turn_lease.sweep_skip_terminal",
                message_id=claimed.message_id,
                entries=len(entries),
            )
            continue

        state = TurnState.from_journal(entries or [])
        if state.plan is not None and state.unfinished_run_ids:
            logger.info(
                "turn_lease.sweep_recover",
                message_id=claimed.message_id,
                conversation_id=claimed.conversation_id,
                unfinished=len(state.unfinished_run_ids),
                completed=len(state.completed),
            )
            # Detached recover — sweeper must not block the loop on a long redrive.
            from agentcore.runtime.recover import recover_expired_lease

            asyncio.create_task(
                recover_expired_lease(claimed, state),
                name=f"recover-lease-{claimed.message_id}",
            )
            started += 1
            continue

        # No unfinished DAG (or empty journal pure-chat) — salvage from stream_state.
        try:
            await salvage_no_dag_turn(
                message_id=claimed.message_id,
                conversation_id=claimed.conversation_id,
            )
        except Exception as e:  # noqa: BLE001 — never stall the sweeper
            logger.warning(
                "turn_lease.sweep_salvage_failed",
                message_id=claimed.message_id,
                error=str(e),
            )
        async with async_session_factory() as session:
            await TurnLeaseRepository(session).release(claimed.message_id)

    if started:
        logger.info("turn_lease.sweep_started", recoveries=started)
    return started


async def turn_lease_sweep_loop() -> None:
    """Run :func:`run_turn_lease_sweep` forever on the configured interval."""
    # Boot pass first so a restart immediately reclaims orphaned RUNNING turns.
    try:
        await run_turn_lease_sweep()
    except Exception as e:  # noqa: BLE001
        log = logger.error if is_schema_error(e) else logger.warning
        log("turn_lease.boot_sweep_failed", error=str(e))

    interval = settings.turn_lease_sweep_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            await run_turn_lease_sweep()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log = logger.error if is_schema_error(e) else logger.warning
            log("turn_lease.sweep_failed", error=str(e))
