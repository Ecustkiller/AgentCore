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

from sqlalchemy import BigInteger, cast, delete, distinct, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from agentcore.core.types import new_id
from agentcore.db.models import (
    Conversation,
    CostEvent,
    Credentials,
    Folder,
    Invite,
    Message,
    RefreshToken,
    User,
)

# Sentinel for "field not provided" in partial updates, distinct from an explicit
# None (which clears a nullable column, e.g. unbinding a folder's local_dir).
_UNSET: object = object()


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


class ConversationRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(self, *, user_id: str, title: str | None = None) -> Conversation:
        # Omit title when not provided so the DB server_default ('') applies.
        # The live `conversations.title` column is NOT NULL; passing an explicit
        # None would emit `INSERT ... title=NULL` and violate the constraint.
        conv = Conversation(id=new_id(), user_id=user_id)
        if title is not None:
            conv.title = title
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
        self, user_id: str, *, limit: int = 50, offset: int = 0
    ) -> tuple[Sequence[Conversation], int]:
        base_query = select(Conversation).where(
            Conversation.user_id == user_id,
            Conversation.deleted_at.is_(None),
        )

        count_result = await self._session.execute(
            select(func.count()).select_from(base_query.subquery())
        )
        total = count_result.scalar_one()

        result = await self._session.execute(
            base_query.order_by(Conversation.updated_at.desc()).limit(limit).offset(offset)
        )
        return result.scalars().all(), total

    async def update_title(
        self, conversation_id: str, title: str, *, user_id: str | None = None
    ) -> Conversation | None:
        conv = await self.get_by_id(conversation_id, user_id=user_id)
        if conv:
            conv.title = title
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

    async def list_all_by_user(self, user_id: str) -> Sequence[Conversation]:
        """Every non-deleted conversation for a user, newest activity first.

        Unpaginated — backs the folder-grouped sidebar, which groups the full
        set client-side (the flat list is small in the desktop MVP).
        """
        result = await self._session.execute(
            select(Conversation)
            .where(
                Conversation.user_id == user_id,
                Conversation.deleted_at.is_(None),
            )
            .order_by(Conversation.updated_at.desc())
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
        self, *, user_id: str, name: str, local_dir: str | None = None
    ) -> Folder:
        folder = Folder(
            id=new_id(), user_id=user_id, name=name, local_dir=local_dir
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
        runs: dict | None = None,
        message_id: str | None = None,
    ) -> Message:
        # `message_id` lets the caller pin the row id to the pipeline's id (the
        # one already sent to the client on `message_start`), so the streamed and
        # persisted assistant message agree; defaults to a fresh id otherwise.
        msg = Message(
            id=message_id or new_id(),
            conversation_id=conversation_id,
            role=role,
            content=content,
            reasoning_content=reasoning_content,
            usage=metadata,
        )
        if attachments is not None:
            msg.attachments = attachments
        if citations is not None:
            msg.citations = citations
        if runs is not None:
            msg.runs = runs
        self._session.add(msg)
        await self._session.commit()
        await self._session.refresh(msg)
        return msg

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
        (conversation branching is a separate, later feature).
        """
        result = await self._session.execute(
            delete(Message).where(
                Message.conversation_id == conversation_id,
                Message.created_at > after_created_at,
            )
        )
        await self._session.commit()
        return result.rowcount or 0


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
        message_id: str,
        runs: Sequence[dict],
    ) -> int:
        """Append one ledger row per run for an assistant turn; return rows written.

        ``runs`` are the runtime's per-run payloads (``asdict(RunCost)``): the
        caller (conversation service) supplies the user / conversation / message
        envelope here so the runtime stays DB-unaware. Idempotent by ``run_id``
        (unique): a retried turn re-sending the same runs inserts nothing the
        second time, so a run is never double-billed. A row id is minted per row
        because a Core bulk insert does not fire the ORM-level default.
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
