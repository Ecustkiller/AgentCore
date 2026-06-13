"""FastAPI dependencies (DB session, current user, etc)."""

from collections.abc import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.base import get_session
from agentcore.db.repositories import (
    ConversationRepository,
    ExecutionRepository,
    MessageRepository,
    UserMemoryRepository,
    UserRepository,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session."""
    async for session in get_session():
        yield session


def get_user_repo(session: AsyncSession = Depends(get_db)) -> UserRepository:
    return UserRepository(session)


def get_conversation_repo(session: AsyncSession = Depends(get_db)) -> ConversationRepository:
    return ConversationRepository(session)


def get_message_repo(session: AsyncSession = Depends(get_db)) -> MessageRepository:
    return MessageRepository(session)


def get_execution_repo(session: AsyncSession = Depends(get_db)) -> ExecutionRepository:
    return ExecutionRepository(session)


def get_memory_repo(session: AsyncSession = Depends(get_db)) -> UserMemoryRepository:
    return UserMemoryRepository(session)
