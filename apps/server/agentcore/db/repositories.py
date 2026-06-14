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

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import (
    Conversation,
    Credentials,
    Invite,
    Message,
    RefreshToken,
    User,
)


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
    ) -> Message:
        msg = Message(
            id=new_id(),
            conversation_id=conversation_id,
            role=role,
            content=content,
            reasoning_content=reasoning_content,
            usage=metadata,
        )
        if attachments is not None:
            msg.attachments = attachments
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

    async def mark_used(self, invite_id: str, *, used_by: str) -> None:
        await self._session.execute(
            update(Invite)
            .where(Invite.id == invite_id)
            .values(used_by=used_by, used_at=datetime.now(UTC))
        )
        await self._session.commit()
