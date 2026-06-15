"""SQLAlchemy base configuration and session management."""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from agentcore.config import settings


class Base(DeclarativeBase):
    """Base class for all ORM models."""

    pass


engine = create_async_engine(
    settings.database_url,
    # SQL echo is governed by its own switch (NOT `debug`) so DEBUG app logs don't
    # drown the AI turn logs under every statement + parameters (see config.py).
    echo=settings.db_echo,
    pool_size=10,
    max_overflow=20,
)

async_session_factory = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dependency that yields an async DB session."""
    async with async_session_factory() as session:
        yield session
