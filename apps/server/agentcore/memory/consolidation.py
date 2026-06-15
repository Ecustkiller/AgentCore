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
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.conversation.history import load_recent_history
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, MessageRepository
from agentcore.llm.factory import build_provider
from agentcore.memory.locks import user_memory_lock
from agentcore.memory.maintenance import maintain_user_memory
from agentcore.memory.store import MemoryStore, default_memory_store
from agentcore.memory.user_memory import LLMMemoryExtractor

logger = get_logger(__name__)


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
                latest = await MessageRepository(session).latest_created_at(
                    conversation_id
                )
                conv = await ConversationRepository(session).get_by_id(conversation_id)
                if conv is None or latest is None:
                    return False
                synced = conv.memory_synced_at
                if synced is not None and latest <= synced:
                    return False  # nothing new since the last pass
                window = await load_recent_history(
                    session,
                    conversation_id,
                    max_messages=settings.memory_consolidation_window_messages,
                )

            changed = False
            if window:
                provider = build_provider()
                try:
                    changed = await maintain_user_memory(
                        user_id=user_id,
                        messages=window,
                        extractor=LLMMemoryExtractor(provider),
                        store=store,
                        today=datetime.now(UTC).date().isoformat(),
                        section_cap=settings.memory_section_bullet_cap,
                    )
                finally:
                    await provider.close()

            async with async_session_factory() as session:
                await ConversationRepository(session).set_memory_synced_at(
                    conversation_id, latest
                )
            logger.info(
                "memory_consolidated",
                conversation_id=conversation_id,
                user_id=user_id,
                changed=changed,
            )
            return changed
    except Exception as e:
        logger.warning(
            "memory_consolidation_failed", conversation_id=conversation_id, error=str(e)
        )
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
            conv = await ConversationRepository(session).get_by_id(self._conversation_id)
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

    def __init__(
        self, *, idle_seconds: float, turn_cap: int, runner: Runner
    ) -> None:
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
        self._timers[conversation_id] = loop.call_later(
            self._idle, self._fire, conversation_id
        )

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
                "memory_consolidation_run_failed",
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
    cutoff = datetime.now(UTC) - timedelta(
        seconds=settings.memory_consolidation_idle_seconds
    )
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
                logger.info("memory_consolidation_swept", count=count)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("memory_consolidation_sweep_failed", error=str(e))
