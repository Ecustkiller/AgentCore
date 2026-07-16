"""Offline long-term-memory consolidation (Agent记忆与知识系统 §1.5, 对标 Dreaming V3).

The user's memory file is refreshed by an OFFLINE pass — not a per-turn extract of a
single exchange. One pass reads the recent conversation window plus the current
memory and merges / dedups / temporally-refreshes it (LLM decides structured ops in
user_memory.py, deterministic code applies them).

Three triggers, all best-effort and off the user-visible path:

1. Idle debounce (live path): each finished turn calls ``schedule_consolidation``,
   which (re)arms a per-conversation timer. The timer fires once the conversation
   has been quiet for ``memory_consolidation_idle_seconds`` — so a burst of turns
   consolidates once, over the whole burst, when the user pauses.
2. Turn-count cap (marathon guard): if a conversation reaches
   ``memory_consolidation_turn_cap`` armed turns without ever idling, the scheduler
   fires immediately so a long unbroken session still gets consolidated.
3. Periodic sweeper (backstop): ``consolidation_loop`` scans for settled
   conversations whose latest message is past the watermark and consolidates them —
   covering a debounce dropped by a restart or a client that closed mid-burst.

Concurrency: a per-user lock (memory/locks.py) serializes passes for one user, and a
``memory_synced_at`` watermark (the latest consolidated message's created_at) makes a
double-trigger idempotent — the second pass sees nothing new and no-ops. The
scheduler state (timers, turn counts) is in-process, matching the single-server MVP
posture; multi-process scaling moves it behind the same seam.

Open-turn deferral: a conversation that is MID-TURN — durably paused at a checkpoint
(e.g. the team_preview 开工卡, which can legitimately sit idle for minutes) or holding
a fresh RUNNING lease — is skipped WITHOUT advancing the watermark. Its message window
contains a partial assistant snapshot; consolidating it would surface a premature
「记忆已更新」card mid-turn and memorize half-finished prose. The turn's own finalize
re-arms consolidation once it truly ends.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.conversation.history import load_recent_history
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import (
    ConversationRepository,
    MemoryUpdateRepository,
    MessageRepository,
    PausedTurnRepository,
    TurnLeaseRepository,
    UserRepository,
)
from agentcore.llm.factory import build_provider
from agentcore.llm.resolve import resolve_credentials
from agentcore.llm.resolve import resolve_turn_model as resolve_user_model
from agentcore.memory.locks import user_memory_lock
from agentcore.memory.maintenance import MemoryUpdateItem, maintain_user_memory
from agentcore.memory.store import MemoryStore, default_memory_store
from agentcore.memory.user_memory import LLMMemoryExtractor
from agentcore.messaging.hub import default_chat_hub

logger = get_logger(__name__)


async def conversation_turn_open(session, conversation_id: str) -> bool:
    """True when the conversation is MID-TURN: durably paused or live-running.

    Paused = a ``paused_turns`` frame exists (team_preview / plan_review / ask_user —
    these legitimately sit idle for minutes waiting on the user). Live = a turn lease
    with a heartbeat fresher than ``turn_lease_ttl_seconds`` (a stale lease is a crash
    leftover and must not block consolidation forever).
    """
    if await PausedTurnRepository(session).exists_for_conversation(conversation_id):
        return True
    fresh_after = datetime.now(UTC) - timedelta(seconds=settings.turn_lease_ttl_seconds)
    return await TurnLeaseRepository(session).exists_fresh_for_conversation(
        conversation_id, after=fresh_after
    )


async def consolidate_conversation(
    conversation_id: str, *, store: MemoryStore | None = None
) -> bool:
    """Consolidate one conversation's recent window into its user's memory file.

    Serialized per user and gated by the watermark: returns False (a no-op) when the
    conversation is gone/empty or has no message newer than ``memory_synced_at``.
    Otherwise runs the consolidation pass, advances the watermark to the latest
    message (even when nothing durable changed, so it is not reprocessed), and
    returns whether the memory file actually changed. Never raises.
    """
    store = store or default_memory_store()
    try:
        async with user_memory_lock_for(conversation_id) as user_id:
            if user_id is None:
                return False
            async with async_session_factory() as session:
                latest = await MessageRepository(session).latest_created_at(conversation_id)
                conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
                if conv is None or latest is None:
                    return False
                # Open-turn deferral (see module docstring): a paused / live turn means
                # the window holds a partial assistant snapshot — skip WITHOUT advancing
                # the watermark; finalize re-arms consolidation when the turn ends.
                if await conversation_turn_open(session, conversation_id):
                    logger.info(
                        "memory.consolidation_deferred_open_turn",
                        conversation_id=conversation_id,
                    )
                    return False
                # Master switch off (Agent记忆与知识系统 §一): don't grow memory. Advance
                # the watermark past these messages so re-enabling later won't
                # retroactively consolidate what was said while memory was off (privacy)
                # and the sweeper stops re-checking this conversation.
                user = await UserRepository(session).get_by_id(user_id)
                if user is not None and not user.memory_enabled:
                    await ConversationRepository(session).set_memory_synced_at(
                        conversation_id, latest
                    )
                    return False
                synced = conv.memory_synced_at
                if synced is not None and latest <= synced:
                    return False  # nothing new since the last pass
                # Project membership (folder_id) → memory project scope: facts true only
                # in this project route to its layer, not global (Agent记忆与知识系统 §1.5).
                # None for a bare chat (folder_id=NULL). Auto-promote is vetoed — any
                # truthy folder_id is a user-created project.
                folder_id = conv.folder_id
                window = await load_recent_history(
                    session,
                    conversation_id,
                    max_messages=settings.memory_consolidation_window_messages,
                )
                # Offline pass runs on the platform key when configured, else the
                # conversation owner's BYOK row (see byok.resolve_credentials).
                credentials = await resolve_credentials(session, user_id, "platform_internal")

            # BYOK with no usable key: skip WITHOUT advancing the watermark.
            # Platform mode keeps None = global key via build_provider(None).
            if window and credentials is None and settings.billing_mode == "byok":
                return False

            changed = False
            # The applied changes this pass made (记忆更新对话内可见, §1.6) — the
            # conversation-tail card's「记了什么」. Stays empty when nothing changed.
            collected: list[MemoryUpdateItem] = []
            if window:
                model = resolve_user_model(credentials)
                provider = build_provider(credentials, purpose="platform_internal")
                try:
                    changed = await maintain_user_memory(
                        user_id=user_id,
                        messages=window,
                        extractor=LLMMemoryExtractor(provider, model=model),
                        store=store,
                        today=datetime.now(UTC).date().isoformat(),
                        section_cap=settings.memory_section_bullet_cap,
                        max_topic_files=settings.memory_max_topic_files,
                        folder_id=folder_id,
                        collect_items=collected,
                    )
                finally:
                    await provider.close()

            update_payload: dict | None = None
            async with async_session_factory() as session:
                await ConversationRepository(session).set_memory_synced_at(conversation_id, latest)
                # 记忆更新对话内可见 (§1.6): persist this pass's applied changes as a
                # conversation-tail record so the「记忆已更新」card replays on reload — it
                # is conversation-level (folds a window of turns), so its own row keyed by
                # conversation_id, not a per-turn turn_journal fact.
                if changed and collected:
                    items = [asdict(it) for it in collected]
                    row = await MemoryUpdateRepository(session).record(
                        conversation_id=conversation_id, user_id=user_id, items=items
                    )
                    update_payload = {
                        "id": row.id,
                        "conversation_id": conversation_id,
                        "created_at": row.created_at.isoformat(),
                        "items": items,
                    }
            # Nudge any live client that memory moved: now conversation-scoped + carrying
            # the applied summary, so an OPEN thread inserts the card live and the「AI 记忆」
            # editor knows to reload (else the shell shows a heads-up toast). The offline
            # pass is off the request path, so this rides the per-user firehose (messaging
            # hub), not the turn SSE. Best-effort — a hub hiccup must not flip the result.
            if changed:
                with contextlib.suppress(Exception):
                    event: dict = {"type": "memory_updated", "conversation_id": conversation_id}
                    if update_payload is not None:
                        event["update"] = update_payload
                    await default_chat_hub().publish([user_id], event)
            logger.info(
                "memory.consolidated",
                conversation_id=conversation_id,
                user_id=user_id,
                changed=changed,
            )
            return changed
    except Exception as e:
        logger.warning("memory.consolidation_failed", conversation_id=conversation_id, error=str(e))
        return False


class _UserLockForConversation:
    """Resolve a conversation's owner, then hold that user's memory lock.

    Returns the ``user_id`` (or None when the conversation is gone) so the caller can
    bail before any work. Resolving the owner OUTSIDE the lock keeps lock acquisition
    keyed by user (not conversation), so all of a user's conversations serialize.
    """

    def __init__(self, conversation_id: str) -> None:
        self._conversation_id = conversation_id
        self._cm = None

    async def __aenter__(self) -> str | None:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(self._conversation_id)
        if conv is None:
            return None
        self._cm = user_memory_lock(conv.user_id)
        await self._cm.__aenter__()
        return conv.user_id

    async def __aexit__(self, *exc) -> None:
        if self._cm is not None:
            await self._cm.__aexit__(*exc)


def user_memory_lock_for(conversation_id: str) -> _UserLockForConversation:
    """Async-context wrapper yielding the owner user_id while holding their lock."""
    return _UserLockForConversation(conversation_id)


# --- Debounce scheduler (live path) ------------------------------------------

Runner = Callable[[str], Awaitable[object]]


class MemoryConsolidationScheduler:
    """Per-conversation debounce + turn-cap trigger for consolidation passes.

    In-process timers (``loop.call_later``); a conversation's pending timer is reset
    on each turn so consolidation fires once the user pauses. ``turn_cap`` forces a
    fire after that many armed turns so a marathon chat that never idles still gets
    consolidated. ``runner`` is injectable for tests; production binds it to
    ``consolidate_conversation``.
    """

    def __init__(self, *, idle_seconds: float, turn_cap: int, runner: Runner) -> None:
        self._idle = idle_seconds
        self._turn_cap = turn_cap
        self._runner = runner
        self._timers: dict[str, asyncio.TimerHandle] = {}
        self._counts: dict[str, int] = {}
        self._tasks: set[asyncio.Task] = set()

    def schedule(self, conversation_id: str) -> None:
        """Register a finished turn: arm/reset the debounce, or fire at the cap."""
        self._counts[conversation_id] = self._counts.get(conversation_id, 0) + 1
        if self._turn_cap and self._counts[conversation_id] >= self._turn_cap:
            self._fire(conversation_id)
            return
        self._cancel_timer(conversation_id)
        loop = asyncio.get_running_loop()
        self._timers[conversation_id] = loop.call_later(self._idle, self._fire, conversation_id)

    def _fire(self, conversation_id: str) -> None:
        self._cancel_timer(conversation_id)
        self._counts.pop(conversation_id, None)
        task = asyncio.ensure_future(self._run(conversation_id))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run(self, conversation_id: str) -> None:
        try:
            await self._runner(conversation_id)
        except Exception as e:  # the runner is already best-effort; belt and braces
            logger.warning(
                "memory.consolidation_run_failed",
                conversation_id=conversation_id,
                error=str(e),
            )

    def _cancel_timer(self, conversation_id: str) -> None:
        timer = self._timers.pop(conversation_id, None)
        if timer is not None:
            timer.cancel()

    async def shutdown(self) -> None:
        """Cancel pending timers and await in-flight passes (clean lifespan exit)."""
        for timer in list(self._timers.values()):
            timer.cancel()
        self._timers.clear()
        self._counts.clear()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)


_default_scheduler: MemoryConsolidationScheduler | None = None


def get_scheduler() -> MemoryConsolidationScheduler:
    """Process-wide scheduler bound to the real runner (lazy, settings-configured)."""
    global _default_scheduler
    if _default_scheduler is None:
        _default_scheduler = MemoryConsolidationScheduler(
            idle_seconds=settings.memory_consolidation_idle_seconds,
            turn_cap=settings.memory_consolidation_turn_cap,
            runner=consolidate_conversation,
        )
    return _default_scheduler


def schedule_consolidation(conversation_id: str) -> None:
    """Arm the debounce for a finished turn (no-op when the feature is disabled)."""
    if not settings.memory_consolidation_enabled:
        return
    get_scheduler().schedule(conversation_id)


async def shutdown_scheduler() -> None:
    """Flush the process-wide scheduler on app shutdown (no-op if never built)."""
    if _default_scheduler is not None:
        await _default_scheduler.shutdown()


# --- Periodic sweeper (backstop) ---------------------------------------------


async def consolidation_sweep_once() -> int:
    """One backstop sweep: consolidate settled chats with un-consolidated messages.

    Returns the number of conversations processed. Each runs through the same
    watermark-gated, per-user-locked runner, so overlap with a live debounce is safe.
    """
    cutoff = datetime.now(UTC) - timedelta(seconds=settings.memory_consolidation_idle_seconds)
    async with async_session_factory() as session:
        pending = await ConversationRepository(session).list_pending_memory_consolidation(
            idle_before=cutoff,
            limit=settings.memory_consolidation_sweep_batch_limit,
        )
    for conversation_id in pending:
        await consolidate_conversation(conversation_id)
    return len(pending)


async def consolidation_loop() -> None:
    """Forever: sleep, then run one backstop sweep. Cancelled cleanly on shutdown."""
    interval = settings.memory_consolidation_sweep_interval_seconds
    while True:
        try:
            await asyncio.sleep(interval)
            count = await consolidation_sweep_once()
            if count:
                logger.info("memory.consolidation_swept", count=count)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Schema fault (missing table/column = pending migration) is persistent,
            # not transient — escalate to error so a watchdog catches the whole sweep
            # silently failing every interval; ordinary transients stay at warning.
            log = logger.error if is_schema_error(e) else logger.warning
            log("memory.consolidation_sweep_failed", error=str(e))
