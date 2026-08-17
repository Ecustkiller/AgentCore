"""Unit tests for the system probes: liveness, readiness, version, update policy.

The database probe is monkeypatched so readiness covers both the ready (200) and
not-ready (503) branches deterministically, without needing a live PostgreSQL.
"""

import httpx
from httpx import ASGITransport

from agentcore.api.routes import system
from agentcore.main import app
from agentcore.observability.disk import HIGH_WATERMARK_PCT, DiskSample
from tests.conftest import LogSpy


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _healthy_disk() -> DiskSample:
    return DiskSample(
        path="/data",
        used_pct=12.0,
        total_bytes=1_000,
        free_bytes=880,
        fstype="ext4",
    )


def _near_full_disk() -> DiskSample:
    return DiskSample(
        path="/data",
        used_pct=99.2,
        total_bytes=1_000,
        free_bytes=8,
        fstype="ext4",
    )


def _assert_disk_field(body: dict) -> None:
    disk = body["disk"]
    assert "path" in disk
    assert "used_pct" in disk


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
    monkeypatch.setattr(system, "redis_ready", _ready)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 200
    assert r.json() == {
        "status": "ready",
        "database": True,
        "disk": {"used_pct": 12.0, "path": "/data"},
    }


async def test_readyz_failure_is_logged(monkeypatch):
    """Probe failure must land in server logs (http.readyz_failed)."""
    spy = LogSpy()
    monkeypatch.setattr(system, "logger", spy)
    monkeypatch.setattr(system, "_last_readyz_ok", True)

    async def _down() -> bool:
        return False

    async def _redis_ok() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _down)
    monkeypatch.setattr(system, "redis_ready", _redis_ok)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 503
    logged = spy.get("http.readyz_failed")
    assert logged["ok"] is False
    assert logged["status"] == "not_ready"
    assert logged["database"] is False
    assert isinstance(logged["probe_ms"], int)


async def test_readyz_failed_coalesces_clustered_probes(monkeypatch):
    """First not_ready always logs; repeats inside 10s are swallowed."""
    spy = LogSpy()
    monkeypatch.setattr(system, "logger", spy)
    monkeypatch.setattr(system, "_last_readyz_ok", True)
    monkeypatch.setattr(system, "_readyz_fail_unlogged", 0)
    monkeypatch.setattr(system, "_readyz_last_fail_log_mono", None)
    clock = {"t": 0.0}
    monkeypatch.setattr(system, "mono_now", lambda: clock["t"])

    async def _down() -> bool:
        return False

    async def _redis_ok() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _down)
    monkeypatch.setattr(system, "redis_ready", _redis_ok)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        first = await c.get("/readyz")
        clock["t"] = 1.0
        second = await c.get("/readyz")
        clock["t"] = 10.0
        third = await c.get("/readyz")

    assert first.status_code == 503
    assert second.status_code == 503
    assert third.status_code == 503
    fails = [kw for name, kw in spy.events if name == "http.readyz_failed"]
    assert len(fails) == 2
    assert fails[0]["fail_count"] == 1
    assert fails[1]["fail_count"] == 2


async def test_readyz_success_logs_only_on_recovery(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(system, "logger", spy)
    monkeypatch.setattr(system, "_last_readyz_ok", False)

    async def _ready() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _ready)
    monkeypatch.setattr(system, "redis_ready", _ready)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        first = await c.get("/readyz")
        second = await c.get("/readyz")

    assert first.status_code == 200
    assert second.status_code == 200
    recoveries = [kw for name, kw in spy.events if name == "http.readyz"]
    assert len(recoveries) == 1
    assert recoveries[0]["ok"] is True


async def test_readyz_returns_503_when_database_down(monkeypatch):
    async def _down() -> bool:
        return False

    async def _redis_ok() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _down)
    monkeypatch.setattr(system, "redis_ready", _redis_ok)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 503
    assert r.json() == {
        "status": "not_ready",
        "database": False,
        "disk": {"used_pct": 12.0, "path": "/data"},
    }


async def test_readyz_includes_redis_when_redis_backend(monkeypatch):
    async def _ready() -> bool:
        return True

    monkeypatch.setattr(system.settings, "rate_limit_backend", "redis")
    monkeypatch.setattr(system, "database_ready", _ready)
    monkeypatch.setattr(system, "redis_ready", _ready)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 200
    assert r.json() == {
        "status": "ready",
        "database": True,
        "disk": {"used_pct": 12.0, "path": "/data"},
        "redis": True,
    }


async def test_readyz_returns_200_when_db_up_but_redis_down(monkeypatch):
    """Redis is soft: DB healthy → HTTP 200 even if redis probe fails."""

    async def _db_ok() -> bool:
        return True

    async def _redis_down() -> bool:
        return False

    monkeypatch.setattr(system.settings, "rate_limit_backend", "redis")
    monkeypatch.setattr(system, "database_ready", _db_ok)
    monkeypatch.setattr(system, "redis_ready", _redis_down)
    monkeypatch.setattr(system, "observe_disk", _healthy_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 200
    assert r.json() == {
        "status": "ready",
        "database": True,
        "disk": {"used_pct": 12.0, "path": "/data"},
        "redis": False,
    }


async def test_readyz_stays_200_when_disk_near_full(monkeypatch):
    """Disk watermark is observational: near-full must not flip 200/503.

    Hard constraint: letting a high watermark mark a still-serving instance
    not-ready would trip the orchestrator restart loop. Status follows DB only.
    """

    async def _db_ok() -> bool:
        return True

    async def _redis_ok() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _db_ok)
    monkeypatch.setattr(system, "redis_ready", _redis_ok)
    monkeypatch.setattr(system, "observe_disk", _near_full_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ready"
    assert body["database"] is True
    assert body["disk"]["used_pct"] == 99.2
    assert body["disk"]["used_pct"] >= HIGH_WATERMARK_PCT
    _assert_disk_field(body)


async def test_readyz_still_503_when_db_down_even_if_disk_full(monkeypatch):
    async def _db_down() -> bool:
        return False

    async def _redis_ok() -> bool:
        return True

    monkeypatch.setattr(system, "database_ready", _db_down)
    monkeypatch.setattr(system, "redis_ready", _redis_ok)
    monkeypatch.setattr(system, "observe_disk", _near_full_disk)
    async with _client() as c:
        r = await c.get("/readyz")

    assert r.status_code == 503
    body = r.json()
    assert body["status"] == "not_ready"
    assert body["database"] is False
    assert body["disk"]["used_pct"] == 99.2


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


async def test_updates_policy_enabled_by_default(monkeypatch):
    # Kill switch open by default; empty min version → null (no hard gate / no banner).
    monkeypatch.setattr(system.settings, "desktop_updates_enabled", True)
    monkeypatch.setattr(system.settings, "desktop_min_version", "")
    async with _client() as c:
        r = await c.get("/updates/policy")

    assert r.status_code == 200
    assert r.json() == {"enabled": True, "min_desktop_version": None}


async def test_updates_policy_reflects_kill_switch(monkeypatch):
    # Flipping the flag false is the kill switch that pauses downloads for a bad
    # release; the client honors it (fail-open only on transport/non-200, not this).
    monkeypatch.setattr(system.settings, "desktop_updates_enabled", False)
    monkeypatch.setattr(system.settings, "desktop_min_version", "")
    async with _client() as c:
        r = await c.get("/updates/policy")

    assert r.status_code == 200
    assert r.json() == {"enabled": False, "min_desktop_version": None}


async def test_updates_policy_exposes_min_desktop_version(monkeypatch):
    monkeypatch.setattr(system.settings, "desktop_updates_enabled", True)
    monkeypatch.setattr(system.settings, "desktop_min_version", "0.6.5")
    async with _client() as c:
        r = await c.get("/updates/policy")

    assert r.status_code == 200
    assert r.json() == {"enabled": True, "min_desktop_version": "0.6.5"}


async def test_updates_policy_blank_min_version_is_null(monkeypatch):
    monkeypatch.setattr(system.settings, "desktop_updates_enabled", True)
    monkeypatch.setattr(system.settings, "desktop_min_version", "  ")
    async with _client() as c:
        r = await c.get("/updates/policy")

    assert r.status_code == 200
    assert r.json()["min_desktop_version"] is None
