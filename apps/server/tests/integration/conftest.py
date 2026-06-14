"""Integration-test fixtures backed by a real PostgreSQL instance.

Each test runs against a throwaway ``agentcore_it`` schema that is created and
dropped per test, so integration tests never touch dev data and stay isolated
from one another. Using a dedicated *schema* (not a separate database) means no
CREATEDB privilege is required — the app role already owns its database.

Tests auto-skip when no PostgreSQL is reachable, keeping unit-only runs green.
The target server comes from ``TEST_DATABASE_URL`` (falls back to the app's
``DATABASE_URL``).
"""

import os
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport
from sqlalchemy import text
from sqlalchemy.exc import InterfaceError, OperationalError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

import agentcore.db.models  # noqa: F401  (register models on Base.metadata)
from agentcore.api.dependencies import get_db
from agentcore.config import settings
from agentcore.db.base import Base
from agentcore.db.repositories import InviteRepository
from agentcore.main import app

_TEST_SCHEMA = "agentcore_it"


def _test_db_url() -> str:
    return os.environ.get("TEST_DATABASE_URL") or settings.database_url


@pytest_asyncio.fixture
async def session_factory() -> AsyncIterator[async_sessionmaker]:
    # search_path = our schema only (plus implicit pg_catalog): keeps create_all
    # from seeing dev tables in `public` and skipping table creation.
    engine = create_async_engine(
        _test_db_url(),
        connect_args={"server_settings": {"search_path": _TEST_SCHEMA}},
        poolclass=NullPool,
    )
    try:
        async with engine.begin() as conn:
            await conn.execute(text(f"DROP SCHEMA IF EXISTS {_TEST_SCHEMA} CASCADE"))
            await conn.execute(text(f"CREATE SCHEMA {_TEST_SCHEMA}"))
            await conn.run_sync(Base.metadata.create_all)
    except (OperationalError, InterfaceError, OSError) as exc:
        await engine.dispose()
        pytest.skip(f"PostgreSQL not available for integration tests: {exc}")

    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _override_get_db() -> AsyncIterator:
        async with factory() as session:
            yield session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        yield factory
    finally:
        app.dependency_overrides.pop(get_db, None)
        async with engine.begin() as conn:
            await conn.execute(text(f"DROP SCHEMA IF EXISTS {_TEST_SCHEMA} CASCADE"))
        await engine.dispose()


@pytest_asyncio.fixture
async def client(session_factory) -> AsyncIterator[httpx.AsyncClient]:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
def new_client(session_factory) -> Callable:
    """Factory for additional clients with independent cookie jars (e.g. IDOR tests)."""

    @asynccontextmanager
    async def _make() -> AsyncIterator[httpx.AsyncClient]:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
            yield c

    return _make


@pytest_asyncio.fixture
async def make_invite(session_factory) -> Callable:
    """Return an async helper that seeds an invite code into the test schema."""

    async def _make(code: str = "INVITE-CODE") -> str:
        async with session_factory() as session:
            await InviteRepository(session).create(code=code)
        return code

    return _make
