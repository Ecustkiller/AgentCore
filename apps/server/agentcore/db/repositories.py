"""Data access layer (Repository pattern).

Each repository handles CRUD for a single model.
- Only data access, no business logic
- Uses select() builder pattern
- Pagination returns (data, total_count)
- Default sort: created_at desc
- commit() and refresh() handled internally
"""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import (
    BigInteger,
    and_,
    cast,
    delete,
    distinct,
    func,
    or_,
    select,
    update,
)
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from agentcore.core.types import new_id
from agentcore.db.models import (
    Chat,
    ChatMember,
    ChatMessage,
    Conversation,
    CostEvent,
    Credentials,
    Folder,
    HandoffJob,
    Invite,
    Message,
    ModelMode,
    PausedTurnRow,
    RefreshToken,
    RunSessionRow,
    TurnJournalRow,
    User,
    UserBlock,
    UserDirectorySettings,
    UserLlmKey,
)

# Sentinel for "field not provided" in partial updates, distinct from an explicit
# None (which clears a nullable column, e.g. unbinding a folder's local_dir).
_UNSET: object = object()


def _ilike_pattern(query: str) -> str:
    """Wrap a user query as a substring ILIKE pattern, escaping LIKE wildcards.

    The user's raw text is matched literally: ``%`` ``_`` and the escape char
    ``\\`` are neutralized so a query like ``50%`` can't turn into a match-all
    wildcard. Used by the global-search repos (ILIKE over title/content/name —
    前端技术与架构.md §9.8).
    """
    escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


class UserRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_by_id(self, user_id: str) -> User | None:
        result = await self._session.execute(
            select(User).where(User.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def get_by_username(self, username: str) -> User | None:
        result = await self._session.execute(
            select(User).where(User.username == username)
        )
        return result.scalar_one_or_none()

    async def get_by_ids(self, user_ids: Sequence[str]) -> dict[str, User]:
        """Fetch users by id, keyed by id — batch lookup for the chat list (avoids
        an N+1 when resolving dm peers / message senders).
        """
        if not user_ids:
            return {}
        result = await self._session.execute(
            select(User).where(User.user_id.in_(user_ids))
        )
        return {u.user_id: u for u in result.scalars().all()}

    async def search(self, query: str, *, limit: int = 20) -> Sequence[User]:
        """People-search for the 消息 page (任意搜人).

        Exact, case-insensitive username match only — no fuzzy prefix — so the
        directory cannot be enumerated by scanning. Disabled (status != active)
        accounts are excluded; discoverability (``user_directory_settings``) is
        enforced one layer up in the service.
        """
        q = query.strip()
        if not q:
            return []
        result = await self._session.execute(
            select(User)
            .where(func.lower(User.username) == q.lower(), User.status == "active")
            .limit(limit)
        )
        return result.scalars().all()

    async def list_all(
        self, *, limit: int = 50, offset: int = 0, query: str | None = None
    ) -> tuple[list[User], int]:
        """All accounts for the admin console (用户管理), newest-first, paginated.

        Unlike ``search`` (exact-match, anti-enumeration for the 找人 directory),
        this is the operator's full roster: an optional ``query`` does a substring
        ILIKE over username/display_name, and disabled accounts are included.
        Returns ``(rows, total)`` so the caller can render page controls.
        """
        conditions: list[ColumnElement[bool]] = []
        q = (query or "").strip()
        if q:
            pattern = _ilike_pattern(q)
            conditions.append(
                or_(User.username.ilike(pattern), User.display_name.ilike(pattern))
            )
        count_stmt = select(func.count()).select_from(User)
        list_stmt = select(User)
        if conditions:
            count_stmt = count_stmt.where(*conditions)
            list_stmt = list_stmt.where(*conditions)
        total = await self._session.scalar(count_stmt)
        result = await self._session.execute(
            list_stmt.order_by(User.created_at.desc()).limit(limit).offset(offset)
        )
        return list(result.scalars().all()), int(total or 0)

    async def create(
        self,
        *,
        username: str,
        display_name: str | None = None,
        email: str | None = None,
        role: str = "user",
        status: str = "active",
    ) -> User:
        user = User(
            user_id=new_id(),
            username=username,
            display_name=display_name or "",
            email=email,
            role=role,
            status=status,
        )
        self._session.add(user)
        await self._session.commit()
        await self._session.refresh(user)
        return user

    async def set_role(self, user_id: str, role: str) -> None:
        await self._session.execute(
            update(User).where(User.user_id == user_id).values(role=role)
        )
        await self._session.commit()

    async def set_status(self, user_id: str, status: str) -> None:
        """Enable/disable an account (admin 用户管理). A disabled user is refused at
        ``get_current_user`` on the next request, so no token revocation is needed.
        """
        await self._session.execute(
            update(User).where(User.user_id == user_id).values(status=status)
        )
        await self._session.commit()

    async def set_default_model_mode(
        self, user_id: str, mode: str | None
    ) -> None:
        """Set (or clear, with ``None``) a user's default 质量档 (llm/modes.py).

        ``None`` clears it back to「inherit the operator default」. The value is an
        opaque mode ref (preset name or custom ModelMode id); validity is enforced
        softly at resolve time (an unknown ref falls back to default), so this only
        persists the selection.
        """
        await self._session.execute(
            update(User).where(User.user_id == user_id).values(default_model_mode=mode)
        )
        await self._session.commit()

    async def set_quota(
        self,
        user_id: str,
        *,
        is_unlimited: bool | object = _UNSET,
        daily_tokens: int | None | object = _UNSET,
        monthly_cost_usd: float | None | object = _UNSET,
        daily_requests: int | None | object = _UNSET,
    ) -> None:
        """Patch a user's per-user quota overrides (成本配额与计费.md §一, 决策④).

        Only the fields actually passed are written, so callers can flip one knob
        without disturbing the others. For the three override dimensions an explicit
        ``None`` clears the override back to「inherit global config」, while ``0``
        means「unlimited for this user」(distinct from ``_UNSET`` = leave unchanged).
        """
        values: dict[str, object] = {}
        if is_unlimited is not _UNSET:
            values["is_unlimited"] = is_unlimited
        if daily_tokens is not _UNSET:
            values["quota_daily_tokens"] = daily_tokens
        if monthly_cost_usd is not _UNSET:
            values["quota_monthly_cost_usd"] = monthly_cost_usd
        if daily_requests is not _UNSET:
            values["quota_daily_requests"] = daily_requests
        if not values:
            return
        await self._session.execute(
            update(User).where(User.user_id == user_id).values(**values)
        )
        await self._session.commit()


class ConversationRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        title: str | None = None,
        folder_id: str | None = None,
        mode: str = "chat",
        model_mode: str | None = None,
    ) -> Conversation:
        # Omit title when not provided so the DB server_default ('') applies.
        # The live `conversations.title` column is NOT NULL; passing an explicit
        # None would emit `INSERT ... title=NULL` and violate the constraint.
        #
        # ``folder_id`` files the chat at creation (a "新建对话 from a folder"):
        # filing it here, rather than with a follow-up move, keeps a chat born in a
        # folder in its folder's workspace from its very first turn — and avoids
        # racing the workspace-lock guard, which would otherwise reject the move
        # once that first turn has landed a message (双模式工作区 §九 ⑩).
        #
        # ``mode`` is "chat" for a normal conversation; a "handoff" conversation is
        # the hidden host for a local→云 cloud job's team run (双模式工作区 P2e /
        # e2), kept out of the sidebar by the list filters below.
        conv = Conversation(id=new_id(), user_id=user_id)
        if title is not None:
            conv.title = title
        if folder_id is not None:
            conv.folder_id = folder_id
        if mode != "chat":
            conv.mode = mode
        if model_mode is not None:
            conv.model_mode = model_mode
        self._session.add(conv)
        await self._session.commit()
        await self._session.refresh(conv)
        return conv

    async def get_by_id(
        self, conversation_id: str, *, user_id: str | None = None
    ) -> Conversation | None:
        # When user_id is given, scope by owner so a non-owner gets None (the
        # route then 404s, preventing cross-user access / existence leaks).
        # Internal trusted callers omit user_id.
        conditions = [
            Conversation.id == conversation_id,
            Conversation.deleted_at.is_(None),
        ]
        if user_id is not None:
            conditions.append(Conversation.user_id == user_id)
        result = await self._session.execute(select(Conversation).where(*conditions))
        return result.scalar_one_or_none()

    async def list_by_user(
        self,
        user_id: str,
        *,
        limit: int = 50,
        offset: int = 0,
        archived: bool = False,
    ) -> tuple[Sequence[Conversation], int]:
        # Hidden handoff-job conversations (双模式工作区 P2e / e2) never show in the
        # sidebar — they exist only to host a cloud run's messages/cost/journal.
        # ``archived`` selects one side of the archive split: the default (False) is
        # the live list (sidebar / 全部对话), True backs the「已归档」view.
        base_query = select(Conversation).where(
            Conversation.user_id == user_id,
            Conversation.deleted_at.is_(None),
            Conversation.mode != "handoff",
            Conversation.archived == archived,
        )

        count_result = await self._session.execute(
            select(func.count()).select_from(base_query.subquery())
        )
        total = count_result.scalar_one()

        # Pinned float to the top (置顶对话), then most-recent activity.
        result = await self._session.execute(
            base_query.order_by(
                Conversation.pinned.desc(), Conversation.updated_at.desc()
            )
            .limit(limit)
            .offset(offset)
        )
        return result.scalars().all(), total

    async def search(
        self, user_id: str, query: str, *, limit: int
    ) -> Sequence[Conversation]:
        """Owner-scoped title substring search (全局搜索 Tier 1).

        ILIKE over ``title``, newest-activity first, capped at ``limit``. Excludes
        soft-deleted and hidden handoff-host conversations — the same visibility as
        the sidebar list, so a hit is always something the user can actually open.
        """
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.user_id == user_id,
                Conversation.deleted_at.is_(None),
                Conversation.mode != "handoff",
                Conversation.title.ilike(_ilike_pattern(query)),
            )
            .order_by(Conversation.updated_at.desc())
            .limit(limit)
        )
        return result.scalars().all()

    async def update_title(
        self, conversation_id: str, title: str, *, user_id: str | None = None
    ) -> Conversation | None:
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.title = title
            await self._session.commit()
            await self._session.refresh(conv)
        return conv

    async def set_model_mode(
        self, conversation_id: str, mode: str | None, *, user_id: str
    ) -> Conversation | None:
        """Set (or clear, with ``None``) a conversation's 质量档 override (llm/modes.py).

        ``None`` falls back to the user's default → operator default. The value is an
        opaque mode ref (preset name or custom ModelMode id); an unknown ref resolves
        safely to default at turn time, so this only persists the selection.
        """
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.model_mode = mode
            await self._session.commit()
            await self._session.refresh(conv)
        return conv

    async def set_pinned(
        self, conversation_id: str, pinned: bool, *, user_id: str
    ) -> Conversation | None:
        """Pin / unpin a conversation (置顶对话). Pinned chats sort to the top of
        the sidebar / list; this only writes the flag."""
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.pinned = pinned
            await self._session.commit()
            await self._session.refresh(conv)
        return conv

    async def set_archived(
        self, conversation_id: str, archived: bool, *, user_id: str
    ) -> Conversation | None:
        """Archive / unarchive a conversation (归档对话, reversible).

        Archiving hides it from the live sidebar / grouped list (it moves to the
        「已归档」view) without deleting it; unarchiving returns it to the list.
        """
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.archived = archived
            await self._session.commit()
            await self._session.refresh(conv)
        return conv

    async def soft_delete(
        self, conversation_id: str, *, user_id: str | None = None
    ) -> bool:
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.deleted_at = datetime.now()
            await self._session.commit()
            return True
        return False

    async def list_purgeable(
        self, *, before: datetime, limit: int
    ) -> Sequence[Conversation]:
        """Soft-deleted conversations whose ``deleted_at`` is at/older than ``before``.

        Backs retention cleanup (决策⑦): these have outlived the grace period and
        are ready for physical removal. Oldest-deleted first, capped by ``limit``.
        """
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.deleted_at.is_not(None),
                Conversation.deleted_at <= before,
            )
            .order_by(Conversation.deleted_at.asc())
            .limit(limit)
        )
        return result.scalars().all()

    async def hard_delete(self, conversation_id: str) -> None:
        """Physically remove a conversation and all its rows (messages + cost ledger
        + turn journal).

        App-level cascade (no DB FK, per repo convention). Used only by retention
        after the grace period — distinct from ``soft_delete`` (the user-facing
        recoverable delete). The ``turn_journal`` replay stream (唯一事实源, §18.3)
        is dropped here too — it would otherwise orphan (it has no own TTL sweep,
        unlike paused_turns / run_sessions).
        """
        await self._session.execute(
            delete(Message).where(Message.conversation_id == conversation_id)
        )
        await self._session.execute(
            delete(CostEvent).where(CostEvent.conversation_id == conversation_id)
        )
        await self._session.execute(
            delete(TurnJournalRow).where(
                TurnJournalRow.conversation_id == conversation_id
            )
        )
        await self._session.execute(
            delete(Conversation).where(Conversation.id == conversation_id)
        )
        await self._session.commit()

    async def set_memory_synced_at(
        self, conversation_id: str, synced_at: datetime
    ) -> None:
        """Advance the long-term-memory consolidation watermark (Agent记忆 §1.5).

        ``synced_at`` is the created_at of the last message folded into the user's
        memory. The runner stamps it after each pass (even a no-op one) so neither
        the debounce nor the sweeper reprocesses already-consolidated messages.
        """
        await self._session.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(memory_synced_at=synced_at)
        )
        await self._session.commit()

    async def set_compaction(
        self,
        conversation_id: str,
        *,
        summary: str,
        compacted_through: datetime,
        input_tokens: int | None,
    ) -> None:
        """Persist the rolling compaction summary + its watermark (执行引擎 §十三 长对话压缩).

        ``summary`` is the merged rolling digest, ``compacted_through`` the created_at
        of the last message folded into it (the loader replays only messages strictly
        newer than this), and ``input_tokens`` the turn-input size that triggered this
        (re)compaction — observability for tuning the threshold. Written once per fold
        by the off-turn background pass (conversation/compaction.py); reused verbatim
        across turns so the DeepSeek exact-prefix cache holds.
        """
        await self._session.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(
                compaction_summary=summary,
                compacted_through=compacted_through,
                compaction_input_tokens=input_tokens,
            )
        )
        await self._session.commit()

    async def list_pending_memory_consolidation(
        self, *, idle_before: datetime, limit: int
    ) -> Sequence[str]:
        """Ids of settled chats that have un-consolidated messages (sweeper work list).

        A conversation qualifies when its latest message is newer than its
        ``memory_synced_at`` watermark (有未整合的新内容) yet is at/older than
        ``idle_before`` (已静默, the debounce window has elapsed). Restricted to
        normal chats — hidden handoff hosts (P2e) carry agent runs, not user talk.
        Oldest-settled first, capped by ``limit``. Backs the periodic backstop that
        covers a debounce dropped by a restart / closed client.
        """
        epoch = datetime(1970, 1, 1, tzinfo=UTC)
        last_msg = func.max(Message.created_at)
        result = await self._session.execute(
            select(Conversation.id)
            .join(Message, Message.conversation_id == Conversation.id)
            .where(
                Conversation.deleted_at.is_(None),
                Conversation.mode == "chat",
            )
            .group_by(Conversation.id, Conversation.memory_synced_at)
            .having(
                and_(
                    last_msg > func.coalesce(Conversation.memory_synced_at, epoch),
                    last_msg <= idle_before,
                )
            )
            .order_by(last_msg.asc())
            .limit(limit)
        )
        return [row[0] for row in result.all()]

    async def list_all_by_user(self, user_id: str) -> Sequence[Conversation]:
        """Every live (non-archived) conversation for a user, pinned-first then
        newest activity.

        Unpaginated — backs the folder-grouped sidebar, which groups the full
        set client-side (the flat list is small in the desktop MVP). Archived
        conversations are excluded here (they live in the separate「已归档」view);
        pinned ones sort to the top (置顶对话).
        """
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.user_id == user_id,
                Conversation.deleted_at.is_(None),
                # Hidden handoff-job conversations (P2e / e2) are not sidebar chats.
                Conversation.mode != "handoff",
                # Archived chats are hidden from the live list (归档对话, reversible).
                Conversation.archived.is_(False),
            )
            .order_by(Conversation.pinned.desc(), Conversation.updated_at.desc())
        )
        return result.scalars().all()

    async def set_folder(
        self, conversation_id: str, folder_id: str | None, *, user_id: str
    ) -> Conversation | None:
        """Move a conversation into a folder (or out, with ``folder_id=None``).

        The caller validates that a non-null ``folder_id`` is an owned, live
        folder; this only writes the membership.
        """
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.folder_id = folder_id
            await self._session.commit()
            await self._session.refresh(conv)
        return conv


class FolderRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        local_dir: str | None = None,
        local_root_id: str | None = None,
        local_subpath: str | None = None,
    ) -> Folder:
        # ``local_root_id`` binds the folder to a desktop FS root at creation (文件
        # 中枢统一 F2): the hub's "添加文件夹 = 建本地绑定项目" is one insert, not a
        # create-then-bind round trip. ``local_subpath`` (工作区对称化 D1a) marks a
        # per-conversation workspace lazily promoted under a shared container root;
        # NULL for an explicitly-added project bound at its root.
        folder = Folder(
            id=new_id(),
            user_id=user_id,
            name=name,
            local_dir=local_dir,
            local_root_id=local_root_id,
            local_subpath=local_subpath,
        )
        self._session.add(folder)
        await self._session.commit()
        await self._session.refresh(folder)
        return folder

    async def get_by_id(
        self, folder_id: str, *, user_id: str | None = None
    ) -> Folder | None:
        conditions = [Folder.id == folder_id, Folder.deleted_at.is_(None)]
        if user_id is not None:
            conditions.append(Folder.user_id == user_id)
        result = await self._session.execute(select(Folder).where(*conditions))
        return result.scalar_one_or_none()

    async def list_by_user(self, user_id: str) -> Sequence[Folder]:
        """A user's live folders, in creation order (sidebar group order)."""
        result = await self._session.execute(
            select(Folder)
            .where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
            .order_by(Folder.created_at.asc())
        )
        return result.scalars().all()

    async def search(
        self, user_id: str, query: str, *, limit: int
    ) -> Sequence[Folder]:
        """Owner-scoped folder-name substring search (全局搜索 Tier 1).

        ILIKE over ``name``, most-recently-updated first, capped at ``limit``;
        soft-deleted folders are excluded.
        """
        result = await self._session.execute(
            select(Folder)
            .where(
                Folder.user_id == user_id,
                Folder.deleted_at.is_(None),
                Folder.name.ilike(_ilike_pattern(query)),
            )
            .order_by(Folder.updated_at.desc())
            .limit(limit)
        )
        return result.scalars().all()

    async def update(
        self,
        folder_id: str,
        *,
        user_id: str,
        name: str | None = None,
        local_dir: str | None | object = _UNSET,
    ) -> Folder | None:
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return None
        if name is not None:
            folder.name = name
        if local_dir is not _UNSET:
            # Explicit None clears the binding (disconnect the local directory).
            folder.local_dir = local_dir  # type: ignore[assignment]
        await self._session.commit()
        await self._session.refresh(folder)
        return folder

    async def set_local_root_id(
        self, folder_id: str, root_id: str | None, *, user_id: str
    ) -> Folder | None:
        """Bind (or unbind, with ``root_id=None``) a folder to a desktop FS root.

        The folder is the shared project space (双模式工作区 §七), so this flips
        every conversation in it to local mode against ``root_id`` (or back to
        cloud when cleared).
        """
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if folder:
            folder.local_root_id = root_id
            await self._session.commit()
            await self._session.refresh(folder)
        return folder

    async def soft_delete(self, folder_id: str, *, user_id: str) -> bool:
        """Soft-delete a folder; its conversations fall back to ungrouped.

        The conversations themselves are kept — only their membership is cleared
        (``folder_id`` → NULL), so deleting a folder never loses chats.
        """
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return False
        folder.deleted_at = datetime.now()
        await self._session.execute(
            update(Conversation)
            .where(
                Conversation.user_id == user_id,
                Conversation.folder_id == folder_id,
            )
            .values(folder_id=None)
        )
        await self._session.commit()
        return True

    async def list_purgeable(
        self, *, before: datetime, limit: int
    ) -> Sequence[Folder]:
        """Soft-deleted folders whose ``deleted_at`` is at/older than ``before``.

        Backs retention cleanup (决策⑦). A deleted folder's conversations were
        already re-parented to ungrouped at soft-delete, so only the folder's own
        (orphaned) project workspace + record remain to purge.
        """
        result = await self._session.execute(
            select(Folder)
            .where(Folder.deleted_at.is_not(None), Folder.deleted_at <= before)
            .order_by(Folder.deleted_at.asc())
            .limit(limit)
        )
        return result.scalars().all()

    async def hard_delete(self, folder_id: str) -> None:
        """Physically remove a folder record (its conversations are already detached)."""
        await self._session.execute(delete(Folder).where(Folder.id == folder_id))
        await self._session.commit()


class ModelModeRepository:
    """User-defined custom 质量档 (llm/modes.py D2). System presets are code-defined."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self, *, user_id: str, name: str, assignments: dict[str, str]
    ) -> ModelMode:
        mode = ModelMode(
            id=new_id(), user_id=user_id, name=name, assignments=assignments
        )
        self._session.add(mode)
        await self._session.commit()
        await self._session.refresh(mode)
        return mode

    async def get_by_id(
        self, mode_id: str, *, user_id: str | None = None
    ) -> ModelMode | None:
        conditions = [ModelMode.id == mode_id, ModelMode.deleted_at.is_(None)]
        if user_id is not None:
            conditions.append(ModelMode.user_id == user_id)
        result = await self._session.execute(select(ModelMode).where(*conditions))
        return result.scalar_one_or_none()

    async def list_by_user(self, user_id: str) -> Sequence[ModelMode]:
        """A user's live custom modes, in creation order."""
        result = await self._session.execute(
            select(ModelMode)
            .where(ModelMode.user_id == user_id, ModelMode.deleted_at.is_(None))
            .order_by(ModelMode.created_at.asc())
        )
        return result.scalars().all()

    async def assignments_by_user(self, user_id: str) -> dict[str, dict[str, str]]:
        """``{mode_id: assignments}`` for the turn resolver (llm/modes.py).

        Loaded once per turn so a conversation/user referencing a custom mode can be
        resolved without the resolver touching the DB (keeps it pure).
        """
        modes = await self.list_by_user(user_id)
        return {m.id: dict(m.assignments or {}) for m in modes}

    async def update(
        self,
        mode_id: str,
        *,
        user_id: str,
        name: str | None = None,
        assignments: dict[str, str] | None = None,
    ) -> ModelMode | None:
        mode = await self.get_by_id(mode_id, user_id=user_id)
        if not mode:
            return None
        if name is not None:
            mode.name = name
        if assignments is not None:
            mode.assignments = assignments
        await self._session.commit()
        await self._session.refresh(mode)
        return mode

    async def soft_delete(self, mode_id: str, *, user_id: str) -> bool:
        mode = await self.get_by_id(mode_id, user_id=user_id)
        if not mode:
            return False
        mode.deleted_at = datetime.now()
        await self._session.commit()
        return True


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

    async def counts_for_conversations(
        self, conversation_ids: Sequence[str]
    ) -> dict[str, int]:
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

    async def list_recent(
        self, conversation_id: str, *, limit: int
    ) -> Sequence[Message]:
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
            await self._session.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id)
                .order_by(Message.created_at.desc())
                .limit(limit + 1)
            )
        ).scalars().all()
        has_more_before = len(rows) > limit
        return list(reversed(rows[:limit])), has_more_before

    async def list_before(
        self, conversation_id: str, *, before: datetime, limit: int
    ) -> tuple[Sequence[Message], bool]:
        """``limit`` messages strictly older than ``before``, chronological (scroll up).

        ``(messages, has_more_before)`` — whether even older messages remain.
        """
        rows = (
            await self._session.execute(
                select(Message)
                .where(
                    Message.conversation_id == conversation_id,
                    Message.created_at < before,
                )
                .order_by(Message.created_at.desc())
                .limit(limit + 1)
            )
        ).scalars().all()
        has_more_before = len(rows) > limit
        return list(reversed(rows[:limit])), has_more_before

    async def list_after(
        self, conversation_id: str, *, after: datetime, limit: int
    ) -> tuple[Sequence[Message], bool]:
        """``limit`` messages strictly newer than ``after``, chronological (scroll down).

        ``(messages, has_more_after)`` — whether even newer messages remain.
        """
        rows = (
            await self._session.execute(
                select(Message)
                .where(
                    Message.conversation_id == conversation_id,
                    Message.created_at > after,
                )
                .order_by(Message.created_at.asc())
                .limit(limit + 1)
            )
        ).scalars().all()
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
            select(func.max(Message.created_at)).where(
                Message.conversation_id == conversation_id
            )
        )
        return result.scalar_one_or_none()

    async def get_by_id(
        self, message_id: str, *, conversation_id: str
    ) -> Message | None:
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

    async def delete_after(
        self, conversation_id: str, *, after_created_at: datetime
    ) -> int:
        """Hard-delete messages created strictly after a point in time.

        Used by regenerate / edit-and-resend to drop the superseded assistant
        reply (and any later turns) before re-running. Messages have no
        soft-delete column — replacing a turn means the old branch is gone
        (conversation branching is a separate, later feature). Each dropped
        message's ``turn_journal`` replay stream goes with it (§18.3 唯一事实源 — it
        could never project without its message).
        """
        await self._session.execute(
            delete(TurnJournalRow).where(
                TurnJournalRow.turn_id.in_(
                    select(Message.id).where(
                        Message.conversation_id == conversation_id,
                        Message.created_at > after_created_at,
                    )
                )
            )
        )
        result = await self._session.execute(
            delete(Message).where(
                Message.conversation_id == conversation_id,
                Message.created_at > after_created_at,
            )
        )
        await self._session.commit()
        return result.rowcount or 0

    async def delete_by_id(
        self, message_id: str, *, conversation_id: str
    ) -> bool:
        """Hard-delete one message (单条消息删除). Returns whether a row was removed.

        Scoped to ``conversation_id`` so a guessed id from another conversation
        won't match (the route has already proven ownership of this conversation —
        IDOR-safe; the turn_journal delete is scoped the same way, so a cross-tenant
        id touches neither row). Messages have no soft-delete column, so this is a
        physical delete; its ``turn_journal`` replay stream is dropped with it (§18.3
        唯一事实源), but the append-only ``cost_events`` ledger is intentionally left
        intact (real spend is never rewritten — 不变量 #1). No-op (False) if absent.
        """
        await self._session.execute(
            delete(TurnJournalRow).where(
                TurnJournalRow.turn_id == message_id,
                TurnJournalRow.conversation_id == conversation_id,
            )
        )
        result = await self._session.execute(
            delete(Message).where(
                Message.id == message_id,
                Message.conversation_id == conversation_id,
            )
        )
        await self._session.commit()
        return (result.rowcount or 0) > 0


def _sum_int(expr: ColumnElement) -> ColumnElement:
    """SUM(expr) coalesced to 0 (so an empty window aggregates to 0, not NULL)."""
    return func.coalesce(func.sum(expr), 0)


def _json_int(column: ColumnElement, key: str) -> ColumnElement:
    """Read a JSONB integer field as a castable BigInteger (nano-USD / tokens).

    ``->>`` yields text; a missing key is NULL, which SUM ignores — so absent
    token/cost keys simply don't contribute rather than erroring.
    """
    return cast(column[key].astext, BigInteger)


class CostEventRepository:
    """Append-only per-run cost ledger (决策②: one row per Run = one Agent's
    participation in a turn, captain root included).

    This is the persistence truth source for money spent: the team payroll is
    rebuilt by querying on ``message_id`` and the account dashboard / quota SUMs
    by ``(user_id, created_at)`` — both reads land here and hit the two composite
    indexes on the table.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def record_runs(
        self,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str | None,
        runs: Sequence[dict],
        trace_id: str | None = None,
    ) -> int:
        """Append one ledger row per run for an assistant turn; return rows written.

        ``runs`` are the runtime's per-run payloads (``asdict(RunCost)``): the
        caller (conversation service) supplies the user / conversation / message
        envelope here so the runtime stays DB-unaware. Idempotent by ``run_id``
        (unique): a retried turn re-sending the same runs inserts nothing the
        second time, so a run is never double-billed. A row id is minted per row
        because a Core bulk insert does not fire the ORM-level default. ``trace_id``
        (the turn's log correlation key) stamps every row so the spend joins to its
        log trace.

        ``message_id`` is ``None`` for off-turn background LLM calls (标题生成 /
        记忆整合, Gap C) — those belong to no assistant turn, so the NULL keeps them
        out of any single turn's per-message 工资单 and out of the「请求数」count,
        while still summing into the account/conversation cost totals.
        """
        if not runs:
            return 0
        rows = [
            {
                "id": new_id(),
                "user_id": user_id,
                "conversation_id": conversation_id,
                "message_id": message_id,
                "run_id": r["run_id"],
                "parent_run_id": r.get("parent_run_id"),
                "agent_id": r.get("agent_id"),
                "role": r.get("role", "member"),
                "model": r.get("model", ""),
                "tokens": r.get("tokens") or {},
                "cost": r.get("cost") or {},
                "cost_total_nano": int(r.get("cost_total_nano", 0)),
                "currency": r.get("currency", "USD"),
                "rounds": int(r.get("rounds", 0)),
                "duration_ms": int(r.get("duration_ms", 0)),
                "trace_id": trace_id,
            }
            for r in runs
        ]
        stmt = pg_insert(CostEvent).values(rows).on_conflict_do_nothing(
            index_elements=["run_id"]
        )
        result = await self._session.execute(stmt)
        await self._session.commit()
        return result.rowcount or 0

    async def list_for_message(
        self, message_id: str, *, user_id: str
    ) -> Sequence[CostEvent]:
        """The per-run rows for one assistant turn — the team payroll (工资单).

        Scoped by ``user_id`` so a non-owner gets an empty list (never another
        user's spend, and no message-existence leak). Ordered oldest-first so the
        captain root (written first) heads the payroll.
        """
        result = await self._session.execute(
            select(CostEvent)
            .where(CostEvent.message_id == message_id, CostEvent.user_id == user_id)
            .order_by(CostEvent.created_at.asc())
        )
        return result.scalars().all()

    async def _aggregate(self, *conditions: ColumnElement) -> dict:
        """SUM tokens/cost/rounds + distinct-turn count over the given filter.

        One round-trip returns the whole rollup the cost endpoints need. Token
        and cost-breakdown components live in JSONB (summed via cast); the turn
        total uses the redundant ``cost_total_nano`` scalar column (precise, and
        index-friendly for the account window). ``turns`` counts distinct
        ``message_id`` — the「请求/回合」proxy for the conversation total + quota.
        """
        stmt = select(
            _sum_int(_json_int(CostEvent.tokens, "input")).label("t_input"),
            _sum_int(_json_int(CostEvent.tokens, "output")).label("t_output"),
            _sum_int(_json_int(CostEvent.tokens, "reasoning")).label("t_reasoning"),
            _sum_int(_json_int(CostEvent.tokens, "cache_hit")).label("t_cache_hit"),
            _sum_int(_json_int(CostEvent.tokens, "cache_miss")).label("t_cache_miss"),
            _sum_int(_json_int(CostEvent.cost, "input")).label("c_input"),
            _sum_int(_json_int(CostEvent.cost, "cached")).label("c_cached"),
            _sum_int(_json_int(CostEvent.cost, "output")).label("c_output"),
            _sum_int(CostEvent.cost_total_nano).label("c_total"),
            _sum_int(CostEvent.rounds).label("rounds"),
            func.count(distinct(CostEvent.message_id)).label("turns"),
        ).where(*conditions)
        row = (await self._session.execute(stmt)).one()
        return {
            "usage": {
                "input": int(row.t_input),
                "output": int(row.t_output),
                "reasoning": int(row.t_reasoning),
                "cache_hit": int(row.t_cache_hit),
                "cache_miss": int(row.t_cache_miss),
            },
            "cost": {
                "input": int(row.c_input),
                "cached": int(row.c_cached),
                "output": int(row.c_output),
                "total": int(row.c_total),
            },
            "rounds": int(row.rounds),
            "turns": int(row.turns),
        }

    async def aggregate_for_conversation(
        self, conversation_id: str, *, user_id: str
    ) -> dict:
        """Cumulative spend for one conversation (对话累计)."""
        return await self._aggregate(
            CostEvent.conversation_id == conversation_id,
            CostEvent.user_id == user_id,
        )

    async def aggregate_for_window(
        self, *, user_id: str, since: datetime
    ) -> dict:
        """A user's spend since a cutoff (account dashboard today / month window).

        Hits ``ix_cost_events_user_created``.
        """
        return await self._aggregate(
            CostEvent.user_id == user_id,
            CostEvent.created_at >= since,
        )

    async def aggregate_by_role_for_window(
        self, *, user_id: str, since: datetime
    ) -> list[dict]:
        """Per-role spend for a user since a cutoff (本月各角色花销 — 团队工资单 by role).

        Groups the window by the ledger ``role`` and SUMs the scalar
        ``cost_total_nano`` (the money truth, index-friendly) plus a distinct-turn
        count per role. Only roles that actually spent (>0) are returned, ordered
        by spend desc so the dashboard leads with the biggest spender (Top 花销) —
        the multi-agent product differentiator a single-agent tool can't show.
        Filters on ``ix_cost_events_user_created`` then groups.
        """
        total = _sum_int(CostEvent.cost_total_nano)
        stmt = (
            select(
                CostEvent.role.label("role"),
                total.label("c_total"),
                func.count(distinct(CostEvent.message_id)).label("turns"),
            )
            .where(CostEvent.user_id == user_id, CostEvent.created_at >= since)
            .group_by(CostEvent.role)
            .having(total > 0)
            .order_by(total.desc())
        )
        rows = (await self._session.execute(stmt)).all()
        return [
            {"role": row.role, "cost_total": int(row.c_total), "turns": int(row.turns)}
            for row in rows
        ]

    async def aggregate_daily_for_window(
        self, *, user_id: str, since: datetime
    ) -> dict[str, int]:
        """Daily spend (UTC days) since a cutoff — the dashboard 7-day trend sparkline.

        Groups the window into UTC calendar days and SUMs ``cost_total_nano`` per
        day, returning an ``{iso_date: nano_total}`` map (only days that had rows).
        The caller zero-fills the absent days so the series is a fixed length. The
        day key is computed in UTC (``created_at AT TIME ZONE 'UTC'``) to match the
        account window boundaries. Filters on ``ix_cost_events_user_created``.
        """
        day = func.date_trunc("day", func.timezone("UTC", CostEvent.created_at))
        stmt = (
            select(
                day.label("day"),
                _sum_int(CostEvent.cost_total_nano).label("c_total"),
            )
            .where(CostEvent.user_id == user_id, CostEvent.created_at >= since)
            .group_by(day)
        )
        rows = (await self._session.execute(stmt)).all()
        return {row.day.date().isoformat(): int(row.c_total) for row in rows}


class HandoffJobRepository:
    """Local→云 handoff jobs (双模式工作区 P2e / e2): a dispatched cloud team run.

    Tracks one job's lifecycle (pending → running → succeeded/failed) and the two
    snapshot ids that bracket it (the base it ran on, the result it produced). All
    reads are owner-scoped so a non-owner gets nothing (IDOR-safe), mirroring the
    conversation repo.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        source_conversation_id: str,
        job_conversation_id: str,
        base_snapshot_id: str,
        task: str,
    ) -> HandoffJob:
        job = HandoffJob(
            id=new_id(),
            user_id=user_id,
            source_conversation_id=source_conversation_id,
            job_conversation_id=job_conversation_id,
            base_snapshot_id=base_snapshot_id,
            task=task,
        )
        self._session.add(job)
        await self._session.commit()
        await self._session.refresh(job)
        return job

    async def get_by_id(
        self, job_id: str, *, user_id: str | None = None
    ) -> HandoffJob | None:
        conditions = [HandoffJob.id == job_id]
        if user_id is not None:
            conditions.append(HandoffJob.user_id == user_id)
        result = await self._session.execute(select(HandoffJob).where(*conditions))
        return result.scalar_one_or_none()

    async def list_for_source(
        self, source_conversation_id: str, *, user_id: str
    ) -> Sequence[HandoffJob]:
        """A source conversation's handoff jobs, newest first (owner-scoped)."""
        result = await self._session.execute(
            select(HandoffJob)
            .where(
                HandoffJob.source_conversation_id == source_conversation_id,
                HandoffJob.user_id == user_id,
            )
            .order_by(HandoffJob.created_at.desc())
        )
        return result.scalars().all()

    async def mark_running(self, job_id: str) -> None:
        await self._session.execute(
            update(HandoffJob)
            .where(HandoffJob.id == job_id)
            .values(status="running")
        )
        await self._session.commit()

    async def mark_succeeded(self, job_id: str, *, result_snapshot_id: str) -> None:
        await self._session.execute(
            update(HandoffJob)
            .where(HandoffJob.id == job_id)
            .values(
                status="succeeded",
                result_snapshot_id=result_snapshot_id,
                finished_at=datetime.now(UTC),
            )
        )
        await self._session.commit()

    async def mark_failed(self, job_id: str, *, error: str) -> None:
        await self._session.execute(
            update(HandoffJob)
            .where(HandoffJob.id == job_id)
            .values(status="failed", error=error, finished_at=datetime.now(UTC))
        )
        await self._session.commit()


class CredentialsRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(self, *, user_id: str, password_hash: str) -> Credentials:
        cred = Credentials(user_id=user_id, password_hash=password_hash)
        self._session.add(cred)
        await self._session.commit()
        await self._session.refresh(cred)
        return cred

    async def get_by_user_id(self, user_id: str) -> Credentials | None:
        result = await self._session.execute(
            select(Credentials).where(Credentials.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def set_failure_state(
        self, user_id: str, *, failed_attempts: int, locked_until: datetime | None
    ) -> None:
        await self._session.execute(
            update(Credentials)
            .where(Credentials.user_id == user_id)
            .values(failed_attempts=failed_attempts, locked_until=locked_until)
        )
        await self._session.commit()

    async def reset_failure_state(self, user_id: str) -> None:
        await self._session.execute(
            update(Credentials)
            .where(Credentials.user_id == user_id)
            .values(failed_attempts=0, locked_until=None)
        )
        await self._session.commit()


class UserLlmKeyRepository:
    """The user's single BYOK DeepSeek key (one row per user). Stores only the
    AES-256-GCM ciphertext; encryption/decryption is the service layer's job.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_by_user_id(self, user_id: str) -> UserLlmKey | None:
        result = await self._session.execute(
            select(UserLlmKey).where(UserLlmKey.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def upsert(self, *, user_id: str, api_key_enc: bytes) -> UserLlmKey:
        """Insert or replace the user's key, resetting status to 'unchecked' (a
        freshly set key has not been connectivity-tested yet)."""
        row = await self.get_by_user_id(user_id)
        if row is not None:
            row.api_key_enc = api_key_enc
            row.status = "unchecked"
            await self._session.commit()
            await self._session.refresh(row)
            return row
        row = UserLlmKey(user_id=user_id, api_key_enc=api_key_enc, status="unchecked")
        self._session.add(row)
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def update_status(self, user_id: str, status: str) -> None:
        await self._session.execute(
            update(UserLlmKey)
            .where(UserLlmKey.user_id == user_id)
            .values(status=status)
        )
        await self._session.commit()

    async def delete(self, user_id: str) -> None:
        await self._session.execute(
            delete(UserLlmKey).where(UserLlmKey.user_id == user_id)
        )
        await self._session.commit()


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        token_hash: str,
        token_family: str,
        expires_at: datetime,
    ) -> RefreshToken:
        token = RefreshToken(
            id=new_id(),
            user_id=user_id,
            token_hash=token_hash,
            token_family=token_family,
            expires_at=expires_at,
        )
        self._session.add(token)
        await self._session.commit()
        await self._session.refresh(token)
        return token

    async def get_by_hash(self, token_hash: str) -> RefreshToken | None:
        result = await self._session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        )
        return result.scalar_one_or_none()

    async def mark_rotated(self, token_id: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == token_id)
            .values(rotated_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def revoke_family(self, token_family: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.token_family == token_family,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def revoke_all_for_user(self, user_id: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()


class InviteRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        code: str,
        created_by: str | None = None,
        expires_at: datetime | None = None,
    ) -> Invite:
        invite = Invite(
            id=new_id(),
            code=code,
            created_by=created_by,
            expires_at=expires_at,
        )
        self._session.add(invite)
        await self._session.commit()
        await self._session.refresh(invite)
        return invite

    async def get_by_code(self, code: str) -> Invite | None:
        result = await self._session.execute(
            select(Invite).where(Invite.code == code)
        )
        return result.scalar_one_or_none()

    async def list_recent(self, *, limit: int = 100) -> Sequence[Invite]:
        result = await self._session.execute(
            select(Invite).order_by(Invite.created_at.desc()).limit(limit)
        )
        return result.scalars().all()

    async def mark_used(self, invite_id: str, *, used_by: str) -> None:
        await self._session.execute(
            update(Invite)
            .where(Invite.id == invite_id)
            .values(used_by=used_by, used_at=datetime.now(UTC))
        )
        await self._session.commit()


class ChatRepository:
    """IM chat domain (消息页 = 找人): chats, members and their messages.

    Separate from the AI conversation/message repos — the 消息 page is human↔human
    plus an official account, sharing the frontend chat core, not these tables.
    All membership-scoped reads let the service 404 a non-member (IDOR-safe).
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    @staticmethod
    def dm_key(user_a: str, user_b: str) -> str:
        """Canonical pair key (sorted) so a dm is one row regardless of who opens it."""
        return ":".join(sorted([user_a, user_b]))

    async def get_dm(self, user_a: str, user_b: str) -> Chat | None:
        result = await self._session.execute(
            select(Chat).where(Chat.dm_key == self.dm_key(user_a, user_b))
        )
        return result.scalar_one_or_none()

    async def create_dm(
        self, *, creator_id: str, peer_id: str, peer_state: str = "pending"
    ) -> Chat:
        """Open a 1:1 chat. The opener joins accepted; the peer starts ``pending``
        (the stranger message-request gate) until they accept/reply.
        """
        chat = Chat(
            id=new_id(),
            type="dm",
            created_by=creator_id,
            dm_key=self.dm_key(creator_id, peer_id),
        )
        self._session.add(chat)
        self._session.add(
            ChatMember(chat_id=chat.id, user_id=creator_id, state="accepted")
        )
        self._session.add(
            ChatMember(chat_id=chat.id, user_id=peer_id, state=peer_state)
        )
        await self._session.commit()
        await self._session.refresh(chat)
        return chat

    async def get_chat(self, chat_id: str) -> Chat | None:
        result = await self._session.execute(select(Chat).where(Chat.id == chat_id))
        return result.scalar_one_or_none()

    async def list_auto_join_chats(self) -> Sequence[Chat]:
        """Chats every new user is auto-joined to (the 内测全员群 mechanism).

        Queried at registration to enroll the new account; a handful of rows in
        practice (the 内测群, later an official broadcast channel).
        """
        result = await self._session.execute(
            select(Chat).where(Chat.auto_join.is_(True))
        )
        return result.scalars().all()

    async def add_member(
        self,
        chat_id: str,
        user_id: str,
        *,
        role: str = "member",
        state: str = "accepted",
        pinned: bool = False,
    ) -> None:
        """Add a user to a chat, idempotently.

        A re-add (same chat_id+user_id) is a no-op — registration auto-join and
        the backfill can both touch a user without duplicating or resetting their
        per-chat state (the PK conflict is ignored).
        """
        stmt = (
            pg_insert(ChatMember)
            .values(
                chat_id=chat_id,
                user_id=user_id,
                role=role,
                state=state,
                pinned=pinned,
            )
            .on_conflict_do_nothing(index_elements=["chat_id", "user_id"])
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def remove_member(self, chat_id: str, user_id: str) -> None:
        """Remove a user from a chat (leave-group / admin-kick). Idempotent."""
        await self._session.execute(
            delete(ChatMember).where(
                ChatMember.chat_id == chat_id, ChatMember.user_id == user_id
            )
        )
        await self._session.commit()

    async def set_membership_flags(
        self,
        chat_id: str,
        user_id: str,
        *,
        muted: bool | None = None,
        pinned: bool | None = None,
    ) -> None:
        """Update a member's per-chat flags (mute / pin); ``None`` leaves a field."""
        values: dict = {}
        if muted is not None:
            values["muted"] = muted
        if pinned is not None:
            values["pinned"] = pinned
        if not values:
            return
        await self._session.execute(
            update(ChatMember)
            .where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
            .values(**values)
        )
        await self._session.commit()

    async def set_admin_mute(
        self, chat_id: str, user_id: str, *, muted_by_admin: bool
    ) -> None:
        """Set/clear a member's admin-imposed 禁言 (Stage 3 审核治理).

        Separate column from the member's own ``muted`` so moderation and
        self-service don't clobber each other; idempotent (a no-op write is fine).
        """
        await self._session.execute(
            update(ChatMember)
            .where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
            .values(muted_by_admin=muted_by_admin)
        )
        await self._session.commit()

    async def get_member(self, chat_id: str, user_id: str) -> ChatMember | None:
        result = await self._session.execute(
            select(ChatMember).where(
                ChatMember.chat_id == chat_id, ChatMember.user_id == user_id
            )
        )
        return result.scalar_one_or_none()

    async def list_members(self, chat_id: str) -> Sequence[ChatMember]:
        result = await self._session.execute(
            select(ChatMember).where(ChatMember.chat_id == chat_id)
        )
        return result.scalars().all()

    async def list_memberships(self, user_id: str) -> Sequence[tuple[Chat, ChatMember]]:
        """A user's chats joined with their per-chat state.

        Pinned chats first (the auto-joined 内测群 is pinned on enrollment so it
        surfaces at the top even before it has any messages), then by recent
        activity (``last_message_at`` desc, NULLs last).
        """
        result = await self._session.execute(
            select(Chat, ChatMember)
            .join(ChatMember, ChatMember.chat_id == Chat.id)
            .where(ChatMember.user_id == user_id)
            .order_by(
                ChatMember.pinned.desc(),
                Chat.last_message_at.desc().nullslast(),
            )
        )
        return [(row[0], row[1]) for row in result.all()]

    async def peer_ids_for(
        self, chat_ids: Sequence[str], *, exclude_user_id: str
    ) -> dict[str, str]:
        """Map each chat id → one other member's id (the dm peer). Batch lookup to
        resolve list-row names without an N+1.
        """
        if not chat_ids:
            return {}
        result = await self._session.execute(
            select(ChatMember.chat_id, ChatMember.user_id).where(
                ChatMember.chat_id.in_(chat_ids),
                ChatMember.user_id != exclude_user_id,
            )
        )
        out: dict[str, str] = {}
        for chat_id, uid in result.all():
            out.setdefault(chat_id, uid)
        return out

    async def add_message(
        self,
        *,
        chat_id: str,
        sender_user_id: str | None,
        content: str,
        sender_type: str = "user",
        content_type: str = "text",
        attachments: list | None = None,
        payload: dict | None = None,
        reply_to_message_id: str | None = None,
        client_msg_id: str | None = None,
    ) -> ChatMessage:
        """Append a message and refresh the chat's list-row preview.

        Idempotent for human sends: a retry with the same ``client_msg_id`` returns
        the already-stored row instead of duplicating (the unique index is the
        backstop). The chat's ``last_message_*`` are bumped so the list re-sorts.
        """
        if client_msg_id is not None and sender_user_id is not None:
            existing = await self._session.execute(
                select(ChatMessage).where(
                    ChatMessage.chat_id == chat_id,
                    ChatMessage.sender_user_id == sender_user_id,
                    ChatMessage.client_msg_id == client_msg_id,
                )
            )
            row = existing.scalar_one_or_none()
            if row is not None:
                return row
        msg = ChatMessage(
            id=new_id(),
            chat_id=chat_id,
            sender_user_id=sender_user_id,
            sender_type=sender_type,
            content=content,
            content_type=content_type,
            reply_to_message_id=reply_to_message_id,
            client_msg_id=client_msg_id,
        )
        if attachments is not None:
            msg.attachments = attachments
        if payload is not None:
            msg.payload = payload
        self._session.add(msg)
        await self._session.execute(
            update(Chat)
            .where(Chat.id == chat_id)
            .values(
                last_message_at=datetime.now(UTC),
                last_message_preview=(content or "")[:200],
            )
        )
        await self._session.commit()
        await self._session.refresh(msg)
        return msg

    async def list_messages(
        self, chat_id: str, *, limit: int = 50, offset: int = 0
    ) -> tuple[Sequence[ChatMessage], int]:
        base_query = select(ChatMessage).where(ChatMessage.chat_id == chat_id)
        count_result = await self._session.execute(
            select(func.count()).select_from(base_query.subquery())
        )
        total = count_result.scalar_one()
        result = await self._session.execute(
            base_query.order_by(ChatMessage.created_at.asc()).limit(limit).offset(offset)
        )
        return result.scalars().all(), total

    async def mark_read(
        self,
        chat_id: str,
        user_id: str,
        *,
        last_read_message_id: str,
        last_read_at: datetime | None = None,
    ) -> None:
        await self._session.execute(
            update(ChatMember)
            .where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
            .values(
                last_read_message_id=last_read_message_id,
                last_read_at=last_read_at or datetime.now(UTC),
            )
        )
        await self._session.commit()

    async def accept_request(self, chat_id: str, user_id: str) -> None:
        """Clear a recipient's pending message-request gate (they accepted/replied)."""
        await self._session.execute(
            update(ChatMember)
            .where(ChatMember.chat_id == chat_id, ChatMember.user_id == user_id)
            .values(state="accepted")
        )
        await self._session.commit()

    async def unread_counts(self, user_id: str) -> dict[str, int]:
        """Per-chat unread message counts for a user, keyed by chat id.

        Unread = messages this user did not send, created after their read cursor
        (``last_read_at``; NULL = never read → all count). Official (NULL sender)
        messages count too — ``is_distinct_from`` treats NULL as "not me". One
        GROUP BY for the whole list (no per-chat round-trips).
        """
        result = await self._session.execute(
            select(ChatMessage.chat_id, func.count())
            .select_from(ChatMessage)
            .join(ChatMember, ChatMember.chat_id == ChatMessage.chat_id)
            .where(
                ChatMember.user_id == user_id,
                ChatMessage.sender_user_id.is_distinct_from(user_id),
                or_(
                    ChatMember.last_read_at.is_(None),
                    ChatMessage.created_at > ChatMember.last_read_at,
                ),
            )
            .group_by(ChatMessage.chat_id)
        )
        return {row[0]: row[1] for row in result.all()}


class UserBlockRepository:
    """Block list for the 消息 page (任意搜人 护栏): symmetric DM denial + report."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def is_blocked_between(self, user_a: str, user_b: str) -> bool:
        """True if either user blocked the other (blocks gate DMs both ways)."""
        result = await self._session.execute(
            select(func.count())
            .select_from(UserBlock)
            .where(
                or_(
                    and_(
                        UserBlock.user_id == user_a,
                        UserBlock.blocked_user_id == user_b,
                    ),
                    and_(
                        UserBlock.user_id == user_b,
                        UserBlock.blocked_user_id == user_a,
                    ),
                )
            )
        )
        return result.scalar_one() > 0

    async def block(self, user_id: str, blocked_user_id: str) -> None:
        stmt = (
            pg_insert(UserBlock)
            .values(user_id=user_id, blocked_user_id=blocked_user_id)
            .on_conflict_do_nothing(index_elements=["user_id", "blocked_user_id"])
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def unblock(self, user_id: str, blocked_user_id: str) -> None:
        await self._session.execute(
            delete(UserBlock).where(
                UserBlock.user_id == user_id,
                UserBlock.blocked_user_id == blocked_user_id,
            )
        )
        await self._session.commit()

    async def list_blocked(self, user_id: str) -> Sequence[str]:
        result = await self._session.execute(
            select(UserBlock.blocked_user_id).where(UserBlock.user_id == user_id)
        )
        return [row[0] for row in result.all()]


class UserDirectoryRepository:
    """Per-user discoverability + who-can-DM privacy (任意搜人 护栏).

    A missing row means defaults (discoverable, anyone can DM) — open search is
    the product default; users opt out by writing a row.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get(self, user_id: str) -> UserDirectorySettings | None:
        result = await self._session.execute(
            select(UserDirectorySettings).where(
                UserDirectorySettings.user_id == user_id
            )
        )
        return result.scalar_one_or_none()

    async def upsert(
        self,
        user_id: str,
        *,
        discoverable: bool | object = _UNSET,
        who_can_dm: str | object = _UNSET,
    ) -> UserDirectorySettings:
        settings = await self.get(user_id)
        if settings is None:
            settings = UserDirectorySettings(user_id=user_id)
            self._session.add(settings)
        if discoverable is not _UNSET:
            settings.discoverable = discoverable  # type: ignore[assignment]
        if who_can_dm is not _UNSET:
            settings.who_can_dm = who_can_dm  # type: ignore[assignment]
        await self._session.commit()
        await self._session.refresh(settings)
        return settings


class RunSessionRepository:
    """Durable store for recoverable worker runs (留人 跨进程落盘, 乙 热修 P3).

    The write path is an upsert by ``run_id``: a freshly-delegated worker inserts;
    a later ``revise`` of the same run updates its transcript / content /
    recall_count and bumps ``updated_at`` (which the TTL sweep reads). The read path
    rehydrates a single run on an in-memory roster miss (restart / eviction).
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self,
        *,
        conversation_id: str,
        run_id: str,
        spec: dict,
        transcript: list,
        content: str,
        recall_count: int,
        trace_id: str | None = None,
    ) -> None:
        """Insert a recoverable session, or update it in place if its ``run_id``
        already exists (a re-revised run). Idempotent re-delegation re-writes the
        same content; a revision advances transcript / recall_count. ``trace_id``
        is set on first insert only (NOT in the update set) so it keeps pointing at
        the interaction that originally spawned the worker, not a later revise."""
        now = datetime.now()
        stmt = (
            pg_insert(RunSessionRow)
            .values(
                run_id=run_id,
                conversation_id=conversation_id,
                spec=spec,
                transcript=transcript,
                content=content,
                recall_count=recall_count,
                trace_id=trace_id,
            )
            .on_conflict_do_update(
                index_elements=["run_id"],
                set_={
                    "spec": spec,
                    "transcript": transcript,
                    "content": content,
                    "recall_count": recall_count,
                    "updated_at": now,
                },
            )
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def get(self, run_id: str) -> RunSessionRow | None:
        result = await self._session.execute(
            select(RunSessionRow).where(RunSessionRow.run_id == run_id)
        )
        return result.scalar_one_or_none()

    async def delete_stale(self, *, before: datetime, limit: int) -> int:
        """Delete up to ``limit`` sessions idle since before ``before`` (7-day TTL).
        Batched so a sweep never holds one huge transaction; returns rows removed."""
        stale = select(RunSessionRow.run_id).where(RunSessionRow.updated_at < before).limit(limit)
        result = await self._session.execute(
            delete(RunSessionRow).where(RunSessionRow.run_id.in_(stale))
        )
        await self._session.commit()
        return result.rowcount or 0


class PausedTurnRepository:
    """Durable store for turns suspended at a plan_review checkpoint (结构化挂起
    turn 级落盘).

    Write is an upsert keyed by the turn's ``message_id`` (re-pausing the same turn
    after a resume-then-pause overwrites in place). The read path either claims one
    row for resume (``claim`` = read-then-delete in one transaction, so two racing
    ``/resume`` calls can't both continue the same turn) or lists a conversation's
    pending paused turns for reopen. ``trace_id`` is set on first insert only so it
    keeps pointing at the originating interaction.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self,
        *,
        message_id: str,
        conversation_id: str,
        user_id: str,
        frame: dict,
        trace_id: str | None = None,
    ) -> None:
        now = datetime.now(UTC)
        stmt = (
            pg_insert(PausedTurnRow)
            .values(
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                frame=frame,
                trace_id=trace_id,
            )
            .on_conflict_do_update(
                index_elements=["message_id"],
                set_={"frame": frame, "updated_at": now},
            )
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def get(self, message_id: str) -> PausedTurnRow | None:
        result = await self._session.execute(
            select(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        )
        return result.scalar_one_or_none()

    async def claim(
        self, message_id: str, *, conversation_id: str | None = None
    ) -> PausedTurnRow | None:
        """Atomically read-and-delete one paused turn for resume.

        DELETE ... RETURNING means only ONE caller wins the row (a second concurrent
        ``/resume`` gets ``None`` → 409), so a paused turn is never resumed twice.
        Scoped to ``conversation_id`` when given so a frame is only ever claimed
        within the conversation the caller has already proven it owns (IDOR-safe — a
        guessed ``message_id`` from another conversation won't match, so it is neither
        returned nor deleted). Returns the row (detached values) or ``None``.
        """
        stmt = delete(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        if conversation_id is not None:
            stmt = stmt.where(PausedTurnRow.conversation_id == conversation_id)
        result = await self._session.execute(stmt.returning(PausedTurnRow))
        row = result.scalar_one_or_none()
        await self._session.commit()
        return row

    async def list_pending(self, conversation_id: str) -> Sequence[PausedTurnRow]:
        """A conversation's paused turns (oldest first) for reopen-time rehydration."""
        result = await self._session.execute(
            select(PausedTurnRow)
            .where(PausedTurnRow.conversation_id == conversation_id)
            .order_by(PausedTurnRow.created_at.asc())
        )
        return result.scalars().all()

    async def delete(self, message_id: str) -> None:
        """Drop a paused turn (live in-process resolve / timeout settled it instead)."""
        await self._session.execute(
            delete(PausedTurnRow).where(PausedTurnRow.message_id == message_id)
        )
        await self._session.commit()

    async def delete_stale(self, *, before: datetime, limit: int) -> int:
        """Delete up to ``limit`` paused turns idle since before ``before`` (TTL sweep).

        ``updated_at`` advances on re-pause (resume → pause again), so an actively
        re-paused turn stays alive while one abandoned past the window is pruned. Also
        clears each pruned turn's ``turn_journal`` rows — the journal-so-far is stored
        there (唯一事实源, §18.3) and would otherwise orphan, since an abandoned pause
        never produces a message to project onto. Batched (one transaction) so a sweep
        never holds one huge lock; returns the number of paused turns removed.
        """
        stale_ids = (
            (
                await self._session.execute(
                    select(PausedTurnRow.message_id)
                    .where(PausedTurnRow.updated_at < before)
                    .limit(limit)
                )
            )
            .scalars()
            .all()
        )
        if not stale_ids:
            return 0
        await self._session.execute(
            delete(TurnJournalRow).where(TurnJournalRow.turn_id.in_(stale_ids))
        )
        result = await self._session.execute(
            delete(PausedTurnRow).where(PausedTurnRow.message_id.in_(stale_ids))
        )
        await self._session.commit()
        return result.rowcount or 0


class TurnJournalRepository:
    """The §18.6 ``Journal`` port's Postgres impl — the唯一事实源 store (§18.3).

    A turn's execution facts are stored append-only, ordered by ``seq`` within a
    ``turn_id`` (== the assistant ``message_id``). :meth:`record` replaces the turn's
    rows wholesale (idempotent for a resume that reuses the id); :meth:`load_map`
    batch-loads several turns for the read-time projection (no N+1 when a history
    page renders). Entries are plain ``{kind, payload, ts}`` dicts — the
    ``runs``↔entries transform lives in ``runtime/journal.py`` (the engine domain),
    keeping this layer pure storage.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def record(
        self,
        *,
        turn_id: str,
        conversation_id: str,
        trace_id: str | None,
        entries: Sequence[dict],
    ) -> None:
        """Replace a turn's journal with ``entries`` (delete-then-insert, one commit).

        Replace (not append) so a resume reusing the same ``turn_id`` re-persists the
        full, current fact stream without duplicating the pre-pause prefix. A no-op
        for empty ``entries`` after clearing any stale rows.
        """
        await self._session.execute(
            delete(TurnJournalRow).where(TurnJournalRow.turn_id == turn_id)
        )
        if entries:
            self._session.add_all(
                [
                    TurnJournalRow(
                        turn_id=turn_id,
                        seq=seq,
                        kind=str(entry.get("kind") or ""),
                        payload=entry.get("payload") or {},
                        ts=entry.get("ts"),
                        conversation_id=conversation_id,
                        trace_id=trace_id,
                    )
                    for seq, entry in enumerate(entries)
                ]
            )
        await self._session.commit()

    async def load(self, turn_id: str) -> list[dict]:
        """One turn's facts as ordered ``{kind, payload, ts}`` entries (``[]`` if none)."""
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(TurnJournalRow.turn_id == turn_id)
            .order_by(TurnJournalRow.seq.asc())
        )
        return [
            {"kind": r.kind, "payload": r.payload, "ts": r.ts}
            for r in result.scalars().all()
        ]

    async def load_map(self, turn_ids: Sequence[str]) -> dict[str, list[dict]]:
        """Several turns' facts keyed by ``turn_id`` (ordered entries), batched.

        One query over all ids (ordered by turn_id, seq) grouped in Python, so a
        history page projects every assistant message's replay payload without an
        N+1. Turns with no facts are simply absent from the map.
        """
        ids = list(dict.fromkeys(turn_ids))
        if not ids:
            return {}
        result = await self._session.execute(
            select(TurnJournalRow)
            .where(TurnJournalRow.turn_id.in_(ids))
            .order_by(TurnJournalRow.turn_id.asc(), TurnJournalRow.seq.asc())
        )
        grouped: dict[str, list[dict]] = {}
        for r in result.scalars().all():
            grouped.setdefault(r.turn_id, []).append(
                {"kind": r.kind, "payload": r.payload, "ts": r.ts}
            )
        return grouped
