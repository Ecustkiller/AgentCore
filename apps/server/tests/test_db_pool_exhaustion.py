"""Primary-pool exhaustion: probe isolation + fast 503 product copy.

Guards the 2026-08-11 incident class: QueuePool saturation must not (a) make
``database_ready`` report PG down via the same pool, or (b) hold HTTP clients for
the historical 30s checkout wait before a bare 500.
"""

from __future__ import annotations

import time
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from sqlalchemy.exc import TimeoutError as SATimeoutError

from agentcore.config.database import DatabaseSettings
from agentcore.core.error_codes import ErrorCode
from agentcore.db import base as db_base
from agentcore.db.errors import (
    DATABASE_UNAVAILABLE_MESSAGE,
    DatabaseUnavailableError,
    is_db_connectivity_error,
    is_pool_timeout_error,
)
from agentcore.middleware.errors import JSONErrorMiddleware

_ORIGIN = "http://localhost:5173"
_POOL_TIMEOUT_MSG = (
    "QueuePool limit of size 16 overflow 16 reached, connection timed out, timeout 30.00"
)


def test_primary_pool_timeout_default_is_short() -> None:
    # Capacity (16+16) stays; only the wait is shortened so clients fail fast.
    # Assert Field defaults (not process settings) so a local DB_POOL_TIMEOUT env
    # override cannot flake this guard.
    assert DatabaseSettings.model_fields["db_pool_timeout"].default == 5
    # Telemetry budget untouched by this change.
    assert DatabaseSettings.model_fields["db_telemetry_pool_timeout"].default == 30


def test_is_pool_timeout_error_detects_sqlalchemy_timeout() -> None:
    err = SATimeoutError(_POOL_TIMEOUT_MSG)
    assert is_pool_timeout_error(err) is True
    # Pool exhaustion is not 「Postgres unreachable」.
    assert is_db_connectivity_error(err) is False


def test_is_pool_timeout_error_walks_cause_chain() -> None:
    root = SATimeoutError(_POOL_TIMEOUT_MSG)
    wrapped = RuntimeError("session open failed")
    wrapped.__cause__ = root
    assert is_pool_timeout_error(wrapped) is True


@pytest.mark.asyncio
async def test_database_ready_unaffected_when_primary_pool_exhausted(monkeypatch) -> None:
    """A: readiness must not checkout the primary QueuePool."""

    @asynccontextmanager
    async def _primary_must_not_run():
        raise AssertionError("database_ready must not use async_session_factory / primary pool")
        yield  # pragma: no cover

    class _ProbeConn:
        async def execute(self, *_a, **_k):
            return None

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return None

    class _StubProbe:
        def __init__(self) -> None:
            self.connect_calls = 0

        def connect(self):
            self.connect_calls += 1
            return _ProbeConn()

        async def dispose(self) -> None:
            return None

    probe = _StubProbe()
    monkeypatch.setattr(db_base, "async_session_factory", _primary_must_not_run)
    # Stub keeps an awaitable ``dispose`` so conftest teardown stays safe even if
    # monkeypatch restoration runs after the dispose fixture.
    monkeypatch.setattr(db_base, "probe_engine", probe)

    assert await db_base.database_ready() is True
    assert probe.connect_calls == 1


@pytest.mark.asyncio
async def test_database_ready_false_when_probe_fails(monkeypatch) -> None:
    class _BoomConn:
        async def execute(self, *_a, **_k):
            raise OSError("connection refused")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_a):
            return None

    class _StubProbe:
        def connect(self):
            return _BoomConn()

        async def dispose(self) -> None:
            return None

    monkeypatch.setattr(db_base, "probe_engine", _StubProbe())

    assert await db_base.database_ready() is False


@pytest.mark.asyncio
async def test_get_session_maps_pool_timeout_to_database_unavailable(monkeypatch) -> None:
    """B: Depends path converts QueuePool timeout into the product 503 error."""

    @asynccontextmanager
    async def _exhausted():
        raise SATimeoutError(_POOL_TIMEOUT_MSG)
        yield  # pragma: no cover

    monkeypatch.setattr(db_base, "async_session_factory", _exhausted)

    gen = db_base.get_session()
    t0 = time.perf_counter()
    with pytest.raises(DatabaseUnavailableError) as ei:
        await gen.__anext__()
    elapsed = time.perf_counter() - t0

    assert str(ei.value) == DATABASE_UNAVAILABLE_MESSAGE
    assert ei.value.status_code == 503
    assert ei.value.code == ErrorCode.DATABASE_UNAVAILABLE
    # Must not wait out the historical 30s pool_timeout.
    assert elapsed < 1.0


def _middleware_app_raising(exc: BaseException) -> FastAPI:
    app = FastAPI()
    app.add_middleware(JSONErrorMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[_ORIGIN],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/boom")
    async def boom() -> dict[str, str]:
        raise exc

    return app


def test_middleware_pool_timeout_returns_503_product_copy() -> None:
    """B: unhandled SATimeoutError (direct factory use) → 503 + 中文产品句."""
    client = TestClient(
        _middleware_app_raising(SATimeoutError(_POOL_TIMEOUT_MSG)),
        raise_server_exceptions=False,
    )
    t0 = time.perf_counter()
    res = client.get("/boom", headers={"Origin": _ORIGIN})
    elapsed = time.perf_counter() - t0

    assert res.status_code == 503
    assert res.json() == {
        "error": {
            "code": ErrorCode.DATABASE_UNAVAILABLE,
            "message": DATABASE_UNAVAILABLE_MESSAGE,
        }
    }
    assert res.headers.get("access-control-allow-origin") == _ORIGIN
    assert elapsed < 1.0


def test_middleware_other_errors_still_500() -> None:
    client = TestClient(
        _middleware_app_raising(ValueError("kaboom")),
        raise_server_exceptions=False,
    )
    res = client.get("/boom", headers={"Origin": _ORIGIN})
    assert res.status_code == 500
    assert res.json()["error"]["code"] == "INTERNAL_ERROR"
