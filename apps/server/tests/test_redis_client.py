"""Unit tests for the shared Redis client factory (M15).

No live Redis: fakes stand in for ``redis.Redis.from_url``. Guarantees:
- one client per process (lru_cache)
- construct-time ``redis_client`` still pings
- readiness reuses the singleton (no per-probe ``from_url``)
"""

from __future__ import annotations

import sys
import types

import pytest

from agentcore.cache import redis as redis_mod
from agentcore.cache import redis_health as health_mod
from agentcore.config import settings


class _FakeRedis:
    def __init__(self) -> None:
        self.pings = 0

    def ping(self) -> bool:
        self.pings += 1
        return True


@pytest.fixture
def clear_redis_cache():
    # Hold the real lru-wrapped factory — tests may monkeypatch the module attr.
    factory = redis_mod.get_redis_client
    factory.cache_clear()
    try:
        yield
    finally:
        factory.cache_clear()


def _install_fake_redis(monkeypatch, *, factory):
    """Make ``import redis`` inside ``get_redis_client`` resolve to ``factory``."""
    fake_mod = types.ModuleType("redis")
    fake_mod.Redis = type("Redis", (), {"from_url": staticmethod(factory)})
    monkeypatch.setitem(sys.modules, "redis", fake_mod)


def test_get_redis_client_is_process_singleton(monkeypatch, clear_redis_cache):
    created: list[_FakeRedis] = []

    def _from_url(*_args, **_kwargs):
        client = _FakeRedis()
        created.append(client)
        return client

    _install_fake_redis(monkeypatch, factory=_from_url)
    a = redis_mod.get_redis_client()
    b = redis_mod.get_redis_client()
    assert a is b
    assert len(created) == 1


def test_get_redis_client_sets_socket_timeouts(monkeypatch, clear_redis_cache):
    """Sync Redis on the event loop must have connect + I/O ceilings (not None)."""
    captured: dict[str, object] = {}

    def _from_url(*_args, **kwargs):
        captured.update(kwargs)
        return _FakeRedis()

    _install_fake_redis(monkeypatch, factory=_from_url)
    redis_mod.get_redis_client()
    assert captured["socket_connect_timeout"] == redis_mod.REDIS_SOCKET_CONNECT_TIMEOUT_S
    assert captured["socket_timeout"] == redis_mod.REDIS_SOCKET_TIMEOUT_S
    assert captured["socket_connect_timeout"] is not None
    assert captured["socket_timeout"] is not None
    assert captured["decode_responses"] is False
    assert captured["retry"] is None


def test_redis_client_pings_shared_instance(monkeypatch, clear_redis_cache):
    fake = _FakeRedis()
    monkeypatch.setattr(redis_mod, "get_redis_client", lambda: fake)
    assert redis_mod.redis_client() is fake
    assert fake.pings == 1
    redis_mod.redis_client()
    assert fake.pings == 2


async def test_redis_ready_reuses_shared_client(monkeypatch, clear_redis_cache):
    fake = _FakeRedis()
    created = 0

    def _from_url(*_args, **_kwargs):
        nonlocal created
        created += 1
        return fake

    _install_fake_redis(monkeypatch, factory=_from_url)
    monkeypatch.setattr(settings, "rate_limit_backend", "redis")

    assert await health_mod.redis_ready() is True
    assert await health_mod.redis_ready() is True
    assert created == 1
    assert fake.pings == 2


async def test_redis_ready_skips_when_memory_backend(monkeypatch):
    def _boom() -> object:
        raise AssertionError("must not touch Redis when backend is memory")

    monkeypatch.setattr(settings, "rate_limit_backend", "memory")
    monkeypatch.setattr(health_mod, "get_redis_client", _boom)
    assert await health_mod.redis_ready() is True


async def test_redis_ready_logs_and_returns_false_on_ping_failure(
    monkeypatch, clear_redis_cache
):
    class _Down:
        def ping(self) -> bool:
            raise ConnectionError("redis unavailable")

    def _from_url(*_args, **_kwargs):
        return _Down()

    _install_fake_redis(monkeypatch, factory=_from_url)
    monkeypatch.setattr(settings, "rate_limit_backend", "redis")
    from tests.conftest import LogSpy

    spy = LogSpy()
    monkeypatch.setattr(health_mod, "logger", spy)
    assert await health_mod.redis_ready() is False
    kw = spy.get("redis.probe_failed")
    assert "unavailable" in kw["error"]
