"""Unit tests for the system probes: liveness, readiness, and version.

The database probe is monkeypatched so readiness covers both the ready (200) and
not-ready (503) branches deterministically, without needing a live PostgreSQL.
"""

import httpx
from httpx import ASGITransport

from agentcore.api.routes import system
from agentcore.main import app


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_livez_is_always_alive_and_skips_dependencies(monkeypatch):
    # Liveness must never probe the DB, so a broken DB can't trip a restart loop.
    async def _must_not_run() -> bool:
        raise AssertionError("liveness must not probe the database")

    monkeypatch.setattr(system, "database_ready", _must_not_run)
    async with _client() as c:
        r = await c.get("/livez")

    assert r.status_code == 200
    assert r.json() == {"status": "alive"}


async def test_readyz_returns_200_when_database_reachable(monkeypatch):
    async def _ready() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _ready)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 200
    assert r.json() == {"status": "ready", "database": True}


async def test_readyz_returns_503_when_database_down(monkeypatch):
    async def _down() -> bool:
        return False

    monkeypatch.setattr(system, "database_ready", _down)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 503
    assert r.json() == {"status": "not_ready", "database": False}


async def test_version_exposes_build_provenance(monkeypatch):
    monkeypatch.setattr(system.settings, "git_sha", "abc1234")
    monkeypatch.setattr(system.settings, "built_at", "2026-06-15T00:00:00Z")
    async with _client() as c:
        r = await c.get("/version")

    assert r.status_code == 200
    body = r.json()
    assert body["git_sha"] == "abc1234"
    assert body["built_at"] == "2026-06-15T00:00:00Z"
    assert isinstance(body["version"], str) and body["version"]
