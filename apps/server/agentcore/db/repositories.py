"""Data access layer (Repository pattern).

Each repository handles CRUD for a single model.
- Only data access, no business logic
- Uses select() builder pattern
- Pagination returns (data, total_count)
- Default sort: created_at desc
- commit() and refresh() handled internally
"""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import Conversation, Execution, Message, User, UserMemory


class UserRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(self, *, email: str, password_hash: str, name: str | None = None) -> User:
        user = User(id=new_id(), email=email, password_hash=password_hash, name=name)
        self._session.add(user)
        await self._session.commit()
        await self._session.refresh(user)
        return user

    async def get_by_id(self, user_id: str) -> User | None:
        result = await self._session.execute(
            select(User).where(User.id == user_id, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        result = await self._session.execute(
            select(User).where(User.email == email, User.deleted_at.is_(None))
        )
        return result.scalar_one_or_none()


class ConversationRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(self, *, user_id: str, title: str | None = None) -> Conversation:
        conv = Conversation(id=new_id(), user_id=user_id, title=title)
        self._session.add(conv)
        await self._session.commit()
        await self._session.refresh(conv)
        return conv

    async def get_by_id(self, conversation_id: str) -> Conversation | None:
        result = await self._session.execute(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.deleted_at.is_(None),
            )
        )
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

    async def update_title(self, conversation_id: str, title: str) -> Conversation | None:
        conv = await self.get_by_id(conversation_id)
        if conv:
            conv.title = title
            await self._session.commit()
            await self._session.refresh(conv)
        return conv

    async def soft_delete(self, conversation_id: str) -> bool:
        conv = await self.get_by_id(conversation_id)
        if conv:
            conv.deleted_at = datetime.now()
            await self._session.commit()
            return True
        return False

    async def increment_message_count(self, conversation_id: str) -> None:
        conv = await self.get_by_id(conversation_id)
        if conv:
            conv.message_count += 1
            await self._session.commit()


class MessageRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        execution_id: str | None = None,
        metadata: dict | None = None,
    ) -> Message:
        msg = Message(
            id=new_id(),
            conversation_id=conversation_id,
            role=role,
            content=content,
            execution_id=execution_id,
            metadata_=metadata or {},
        )
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


class ExecutionRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self, *, conversation_id: str, plan: dict, status: str = "planning"
    ) -> Execution:
        execution = Execution(
            id=new_id(),
            conversation_id=conversation_id,
            plan=plan,
            status=status,
        )
        self._session.add(execution)
        await self._session.commit()
        await self._session.refresh(execution)
        return execution

    async def get_by_id(self, execution_id: str) -> Execution | None:
        result = await self._session.execute(
            select(Execution).where(Execution.id == execution_id)
        )
        return result.scalar_one_or_none()

    async def update_status(
        self, execution_id: str, status: str, *, completed_at: datetime | None = None
    ) -> Execution | None:
        execution = await self.get_by_id(execution_id)
        if execution:
            execution.status = status
            if completed_at:
                execution.completed_at = completed_at
            await self._session.commit()
            await self._session.refresh(execution)
        return execution


class UserMemoryRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_or_create(self, user_id: str) -> UserMemory:
        result = await self._session.execute(
            select(UserMemory).where(UserMemory.user_id == user_id)
        )
        memory = result.scalar_one_or_none()
        if not memory:
            memory = UserMemory(user_id=user_id)
            self._session.add(memory)
            await self._session.commit()
            await self._session.refresh(memory)
        return memory

    async def update_preferences(self, user_id: str, preferences: dict) -> UserMemory:
        memory = await self.get_or_create(user_id)
        memory.preferences = preferences
        await self._session.commit()
        await self._session.refresh(memory)
        return memory

    async def add_facts(self, user_id: str, new_facts: list[str]) -> UserMemory:
        memory = await self.get_or_create(user_id)
        existing = set(memory.facts)
        merged = list(existing | set(new_facts))
        memory.facts = merged
        await self._session.commit()
        await self._session.refresh(memory)
        return memory
