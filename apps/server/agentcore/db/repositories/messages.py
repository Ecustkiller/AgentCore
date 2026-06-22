"""Message (对话消息 / turn) data access."""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import Conversation, Message

from ._base import _ilike_pattern
from ._journal_cascade import delete_journal_after, delete_journal_for_message


class MessageRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        reasoning_content: str | None = None,
        metadata: dict | None = None,
        attachments: list | None = None,
        citations: list | None = None,
        message_id: str | None = None,
        trace_id: str | None = None,
    ) -> Message:
        # `message_id` lets the caller pin the row id to the pipeline's id (the
        # one already sent to the client on `message_start`), so the streamed and
        # persisted assistant message agree; defaults to a fresh id otherwise.
        # `trace_id` (the turn's log correlation key) is supplied by the caller —
        # which owns the contextvar scope — so this row joins to its log trace.
        msg = Message(
            id=message_id or new_id(),
            conversation_id=conversation_id,
            role=role,
            content=content,
            reasoning_content=reasoning_content,
            usage=metadata,
            trace_id=trace_id,
        )
        if attachments is not None:
            msg.attachments = attachments
        if citations is not None:
            msg.citations = citations
        self._session.add(msg)
        await self._session.commit()
        await self._session.refresh(msg)
        return msg

    async def count_by_conversation(self, conversation_id: str) -> int:
        """Number of messages in a conversation (0 for a brand-new, unsent one).

        Backs the "started?" check the move guard uses to lock a conversation's
        workspace once it has begun (双模式工作区 §九 ⑩).
        """
        result = await self._session.execute(
            select(func.count())
            .select_from(Message)
            .where(Message.conversation_id == conversation_id)
        )
        return result.scalar_one()

    async def counts_for_conversations(self, conversation_ids: Sequence[str]) -> dict[str, int]:
        """Message counts keyed by conversation id, for the ids given.

        One GROUP BY for the whole sidebar so per-conversation counts don't fan out
        into an N+1. Ids with no messages are simply absent from the map (callers
        default them to 0).
        """
        if not conversation_ids:
            return {}
        result = await self._session.execute(
            select(Message.conversation_id, func.count())
            .where(Message.conversation_id.in_(conversation_ids))
            .group_by(Message.conversation_id)
        )
        return {row[0]: row[1] for row in result.all()}

    async def search(
        self, user_id: str, query: str, *, limit: int
    ) -> Sequence[tuple[Message, str]]:
        """Owner-scoped message-content substring search (全局搜索 Tier 1).

        ``messages`` carries no ``user_id``, so this JOINs ``conversations`` to scope
        by owner (never another user's content — IDOR-safe) and to exclude
        soft-deleted and hidden handoff-host conversations. ILIKE over ``content``,
        newest-first, capped at ``limit``. Returns ``(message, conversation_title)``
        pairs so the route can render the owning conversation as list-row context
        without an N+1.
        """
        result = await self._session.execute(
            select(Message, Conversation.title)
            .join(Conversation, Conversation.id == Message.conversation_id)
            .where(
                Conversation.user_id == user_id,
                Conversation.deleted_at.is_(None),
                Conversation.mode != "handoff",
                Message.content.is_not(None),
                Message.content.ilike(_ilike_pattern(query)),
            )
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
        return [(row[0], row[1]) for row in result.all()]

    async def list_by_conversation(
        self, conversation_id: str, *, limit: int = 100, offset: int = 0
    ) -> tuple[Sequence[Message], int]:
        base_query = select(Message).where(Message.conversation_id == conversation_id)

        count_result = await self._session.execute(
            select(func.count()).select_from(base_query.subquery())
        )
        total = count_result.scalar_one()

        result = await self._session.execute(
            base_query.order_by(Message.created_at.asc()).limit(limit).offset(offset)
        )
        return result.scalars().all(), total

    async def list_all_for_conversation(self, conversation_id: str) -> Sequence[Message]:
        """Every message of a conversation, oldest-first — the full transcript.

        Backs export (导出对话) and the share snapshot (分享对话): both freeze/serialize
        the WHOLE conversation, not a scroll window, so an unbounded ordered read is
        the right shape (an explicit, infrequent operation, unlike the paginated chat
        view). Returns rows in render order (created_at asc).
        """
        result = await self._session.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.asc())
        )
        return result.scalars().all()

    async def list_recent(self, conversation_id: str, *, limit: int) -> Sequence[Message]:
        """The most recent ``limit`` messages, returned in chronological order.

        Unlike ``list_by_conversation`` (oldest-first page), this tails the
        conversation — the window the offline memory consolidation reconciles
        against the existing memory (memory/consolidation.py).
        """
        result = await self._session.execute(
            select(Message)
            .where(Message.conversation_id == conversation_id)
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
        return list(reversed(result.scalars().all()))

    async def list_recent_after(
        self, conversation_id: str, *, after: datetime, limit: int
    ) -> Sequence[Message]:
        """The most recent ``limit`` messages STRICTLY NEWER than ``after``, chronological.

        The compaction loader's window above the watermark (执行引擎 §十三 长对话压缩):
        replays the un-folded tail (everything after ``compacted_through``) prefixed by
        the rolling summary. Recent-biased like ``list_recent`` — under a stalled
        compaction the tail can outgrow ``limit``, and dropping the OLDEST of it (which
        are at least near the summary boundary) is safer than dropping the newest, which
        would re-introduce the very recency loss compaction exists to avoid.
        """
        result = await self._session.execute(
            select(Message)
            .where(
                Message.conversation_id == conversation_id,
                Message.created_at > after,
            )
            .order_by(Message.created_at.desc())
            .limit(limit)
        )
        return list(reversed(result.scalars().all()))

    # --- Cursor windows (载入模型: 最新窗口 + 上下滚动 + 命中定位, load-around B) ---
    # The client opens on the latest window, then scrolls up (``list_before``) /
    # down (``list_after``), or jumps to a window centered on a message
    # (``window_around``) for a search hit. Each fetches ``limit + 1`` rows so the
    # extra row exactly answers "is there more in this direction?" without a second
    # count query. All return messages chronological (oldest-first) to match render
    # order. Cursors are ``created_at`` (strict ``<`` / ``>``): a tie at the
    # boundary is a tolerated MVP simplification — conversation turns are inserted
    # seconds apart, unlike rapid IM.

    async def list_latest(
        self, conversation_id: str, *, limit: int
    ) -> tuple[Sequence[Message], bool]:
        """The newest ``limit`` messages, chronological. ``(messages, has_more_before)``."""
        rows = (
            (
                await self._session.execute(
                    select(Message)
                    .where(Message.conversation_id == conversation_id)
                    .order_by(Message.created_at.desc())
                    .limit(limit + 1)
                )
            )
            .scalars()
            .all()
        )
        has_more_before = len(rows) > limit
        return list(reversed(rows[:limit])), has_more_before

    async def list_before(
        self, conversation_id: str, *, before: datetime, limit: int
    ) -> tuple[Sequence[Message], bool]:
        """``limit`` messages strictly older than ``before``, chronological (scroll up).

        ``(messages, has_more_before)`` — whether even older messages remain.
        """
        rows = (
            (
                await self._session.execute(
                    select(Message)
                    .where(
                        Message.conversation_id == conversation_id,
                        Message.created_at < before,
                    )
                    .order_by(Message.created_at.desc())
                    .limit(limit + 1)
                )
            )
            .scalars()
            .all()
        )
        has_more_before = len(rows) > limit
        return list(reversed(rows[:limit])), has_more_before

    async def list_after(
        self, conversation_id: str, *, after: datetime, limit: int
    ) -> tuple[Sequence[Message], bool]:
        """``limit`` messages strictly newer than ``after``, chronological (scroll down).

        ``(messages, has_more_after)`` — whether even newer messages remain.
        """
        rows = (
            (
                await self._session.execute(
                    select(Message)
                    .where(
                        Message.conversation_id == conversation_id,
                        Message.created_at > after,
                    )
                    .order_by(Message.created_at.asc())
                    .limit(limit + 1)
                )
            )
            .scalars()
            .all()
        )
        has_more_after = len(rows) > limit
        return rows[:limit], has_more_after

    async def window_around(
        self, conversation_id: str, *, message_id: str, before: int, after: int
    ) -> tuple[Sequence[Message], bool, bool] | None:
        """A window centered on a message (search-hit jump, load-around B).

        ``before`` older + the target + ``after`` newer, chronological. Returns
        ``(messages, has_more_before, has_more_after)``, or ``None`` if the message
        is not in this conversation (the route 404s).
        """
        target = await self.get_by_id(message_id, conversation_id=conversation_id)
        if target is None:
            return None
        older, has_more_before = await self.list_before(
            conversation_id, before=target.created_at, limit=before
        )
        newer, has_more_after = await self.list_after(
            conversation_id, after=target.created_at, limit=after
        )
        return [*older, target, *newer], has_more_before, has_more_after

    async def latest_created_at(self, conversation_id: str) -> datetime | None:
        """created_at of the newest message (None when the conversation is empty).

        The memory consolidation watermark: the runner skips when this is not newer
        than the stored watermark, and stamps the watermark to it after a pass.
        """
        result = await self._session.execute(
            select(func.max(Message.created_at)).where(Message.conversation_id == conversation_id)
        )
        return result.scalar_one_or_none()

    async def get_by_id(self, message_id: str, *, conversation_id: str) -> Message | None:
        result = await self._session.execute(
            select(Message).where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
            )
        )
        return result.scalar_one_or_none()

    async def update_content(self, message_id: str, content: str) -> None:
        await self._session.execute(
            update(Message).where(Message.id == message_id).values(content=content)
        )
        await self._session.commit()

    async def delete_after(self, conversation_id: str, *, after_created_at: datetime) -> int:
        """Hard-delete messages created strictly after a point in time.

        Used by regenerate / edit-and-resend to drop the superseded assistant
        reply (and any later turns) before re-running. Messages have no
        soft-delete column — replacing a turn means the old branch is gone
        (conversation branching is a separate, later feature). Each dropped
        message's ``turn_journal`` replay stream goes with it (§18.3 唯一事实源 — it
        could never project without its message).
        """
        await delete_journal_after(
            self._session, conversation_id, after_created_at=after_created_at
        )
        result = await self._session.execute(
            delete(Message).where(
                Message.conversation_id == conversation_id,
                Message.created_at > after_created_at,
            )
        )
        await self._session.commit()
        return result.rowcount or 0

    async def delete_by_id(self, message_id: str, *, conversation_id: str) -> bool:
        """Hard-delete one message (单条消息删除). Returns whether a row was removed.

        Scoped to ``conversation_id`` so a guessed id from another conversation
        won't match (the route has already proven ownership of this conversation —
        IDOR-safe; the turn_journal delete is scoped the same way, so a cross-tenant
        id touches neither row). Messages have no soft-delete column, so this is a
        physical delete; its ``turn_journal`` replay stream is dropped with it (§18.3
        唯一事实源), but the append-only ``cost_events`` ledger is intentionally left
        intact (real spend is never rewritten — 不变量 #1). No-op (False) if absent.
        """
        await delete_journal_for_message(self._session, conversation_id, message_id)
        result = await self._session.execute(
            delete(Message).where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
            )
        )
        await self._session.commit()
        return (result.rowcount or 0) > 0
