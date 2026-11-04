"""opt-in 共享状态后端（#8，生成 / 最后修订 2026-11-04）。

守四条：默认 memory 与上游等价；redis 能让「另一个进程」看见同一条状态；
Redis 故障一律 fail-open 且不拆掉限流；**共享后端全开也不解锁多 worker**。
"""

from __future__ import annotations

import json

import pytest

from agentcore.cache.shared_state import (
    CLAIM_KEY_PREFIX,
    COOLDOWN_KEY_PREFIX,
    SHARED_STATE_CAPABILITIES,
    MemoryCooldownStore,
    MemoryTurnClaimStore,
    RedisCooldownStore,
    RedisTurnClaimStore,
    StoredSlot,
    build_cooldown_store,
    build_turn_claim_store,
)
from agentcore.config import settings
from agentcore.config.shared_state import SharedStateSettings
from agentcore.conversation.inference_rate_limit import (
    _TurnClaimGate,
    enforce_inference_proxy_rate_limit,
)
from agentcore.core.errors import RateLimitedError
from agentcore.llm.provider.cooldown_gate import (
    arm_cooldown,
    clear_cooldown,
    cooldown_remaining,
    override_cooldown_store,
    peek_cooldown,
)
from agentcore.middleware.rate_limit import SlidingWindowRateLimiter


class FakeRedis:
    """In-memory stand-in for the sync redis-py subset; can simulate an outage."""

    def __init__(self) -> None:
        self.data: dict[str, bytes] = {}
        self.ttl_ms: dict[str, int] = {}
        self.set_calls: list[dict] = []
        self.fail = False

    def _guard(self) -> None:
        if self.fail:
            raise RuntimeError("redis down")

    def get(self, name: str) -> object:
        self._guard()
        return self.data.get(name)

    def set(
        self, name: str, value: bytes, ex: int | None = None, nx: bool = False
    ) -> object:
        self._guard()
        self.set_calls.append({"name": name, "value": value, "ex": ex, "nx": nx})
        if nx and name in self.data:
            return None
        self.data[name] = value
        self.ttl_ms[name] = int(ex or 0) * 1000
        return True

    def delete(self, name: str) -> object:
        self._guard()
        self.data.pop(name, None)
        self.ttl_ms.pop(name, None)
        return 1

    def pttl(self, name: str) -> object:
        self._guard()
        if name not in self.data:
            return -2
        return self.ttl_ms.get(name, -1)

    def exists(self, name: str) -> object:
        self._guard()
        return 1 if name in self.data else 0


@pytest.fixture
def fake_redis() -> FakeRedis:
    return FakeRedis()


# --- 口径与默认值 --------------------------------------------------------------


def test_capabilities_are_honest():
    assert SHARED_STATE_CAPABILITIES["default_backend"] == "memory"
    assert SHARED_STATE_CAPABILITIES["multi_worker_still_refused"] is True
    assert SHARED_STATE_CAPABILITIES["startup_validation_untouched"] is True
    assert SHARED_STATE_CAPABILITIES["cross_process_event_fanout"] is False
    assert SHARED_STATE_CAPABILITIES["turn_claim_cross_process_toctou_removed"] is False
    assert SHARED_STATE_CAPABILITIES["declares_multi_instance_ready"] is False


def test_default_backends_are_memory():
    cfg = SharedStateSettings()
    assert cfg.llm_cooldown_backend == "memory"
    assert cfg.inference_turn_claim_backend == "memory"


def test_backend_choice_normalizes_case():
    cfg = SharedStateSettings(
        llm_cooldown_backend=" REDIS ", inference_turn_claim_backend="Redis"
    )
    assert cfg.llm_cooldown_backend == "redis"
    assert cfg.inference_turn_claim_backend == "redis"


def test_builders_default_to_memory(monkeypatch):
    monkeypatch.setattr(settings, "llm_cooldown_backend", "memory")
    monkeypatch.setattr(settings, "inference_turn_claim_backend", "memory")
    assert isinstance(build_cooldown_store(), MemoryCooldownStore)
    assert isinstance(build_turn_claim_store(ttl_seconds=60), MemoryTurnClaimStore)


def test_multi_worker_still_refused_even_with_both_shared_backends_on(monkeypatch):
    """本项最有牙齿的回归锚：共享后端全开，启动校验也绝不松口。"""
    from agentcore.main import _validate_single_process_assumptions

    monkeypatch.setattr(settings, "debug", False)
    monkeypatch.setattr(settings, "rate_limit_backend", "redis")
    monkeypatch.setattr(settings, "llm_cooldown_backend", "redis")
    monkeypatch.setattr(settings, "inference_turn_claim_backend", "redis")
    monkeypatch.setenv("AGENTCORE_API_WORKERS", "2")
    with pytest.raises(RuntimeError, match="cross-process"):
        _validate_single_process_assumptions()


# --- 429 冷却槽 ----------------------------------------------------------------


def test_memory_cooldown_matches_legacy_semantics(monkeypatch):
    """默认后端：单调时钟、never shortens、惰性过期，逐字段不改。"""
    monkeypatch.setattr(settings, "llm_cooldown_backend", "memory")
    override_cooldown_store(None)
    ticks = {"t": 0.0}
    monkeypatch.setattr(
        "agentcore.llm.provider.cooldown_gate.time.monotonic", lambda: ticks["t"]
    )
    key = "p:turn"
    arm_cooldown(key, 2.0, "header")
    first = peek_cooldown(key)
    assert first is not None
    assert first.recovery_at == 2.0
    assert first.seconds == 2.0
    arm_cooldown(key, 1.0, "backoff")
    assert peek_cooldown(key) == first
    arm_cooldown(key, 5.0, "backoff")
    assert peek_cooldown(key).seconds == 5.0
    assert cooldown_remaining(key) == 5.0
    ticks["t"] = 5.0
    assert peek_cooldown(key) is None


def test_redis_cooldown_is_visible_to_another_process(fake_redis):
    first_process = RedisCooldownStore(fake_redis)
    second_process = RedisCooldownStore(fake_redis)
    override_cooldown_store(first_process)
    arm_cooldown("p:turn", 5.0, "header")
    assert peek_cooldown("p:turn") is not None

    # 模拟请求落到另一个进程：换 store 后仍能读到同一条武装。
    override_cooldown_store(second_process)
    slot = peek_cooldown("p:turn")
    assert slot is not None
    assert slot.seconds == 5.0
    assert slot.source == "header"
    assert cooldown_remaining("p:turn") == 5.0
    assert fake_redis.set_calls[0]["name"] == f"{COOLDOWN_KEY_PREFIX}p:turn"
    assert fake_redis.set_calls[0]["ex"] == 5


def test_redis_cooldown_uses_relative_ttl_not_monotonic_clock(fake_redis):
    """PTTL 换算剩余，绝不能把单调时钟绝对值塞进 Redis。"""
    store = RedisCooldownStore(fake_redis)
    store.set("k", StoredSlot(remaining=9.0, seconds=9.0, source="header"), now=0.0)
    assert fake_redis.ttl_ms[f"{COOLDOWN_KEY_PREFIX}k"] == 9000
    assert store.get("k", now=10_000.0).remaining == 9.0
    fake_redis.ttl_ms[f"{COOLDOWN_KEY_PREFIX}k"] = 2500
    assert store.get("k", now=10_000.0).remaining == 2.5


def test_redis_cooldown_never_shortens_and_clear_is_key_scoped(fake_redis):
    override_cooldown_store(RedisCooldownStore(fake_redis))
    arm_cooldown("p:turn", 5.0, "header")
    arm_cooldown("p:title", 2.0, "backoff")
    arm_cooldown("p:turn", 1.0, "backoff")
    assert peek_cooldown("p:turn").seconds == 5.0
    clear_cooldown("p:turn")
    assert peek_cooldown("p:turn") is None
    assert peek_cooldown("p:title") is not None


@pytest.mark.parametrize("pttl", [-2, -1, 0])
def test_redis_cooldown_expired_or_unsane_ttl_is_open(fake_redis, pttl):
    name = f"{COOLDOWN_KEY_PREFIX}k"
    fake_redis.data[name] = json.dumps({"seconds": 5.0, "source": "x"}).encode()
    fake_redis.ttl_ms[name] = pttl
    assert RedisCooldownStore(fake_redis).get("k", now=0.0) is None


def test_redis_cooldown_bad_payload_is_open(fake_redis):
    name = f"{COOLDOWN_KEY_PREFIX}k"
    fake_redis.data[name] = b"not-json"
    fake_redis.ttl_ms[name] = 5000
    assert RedisCooldownStore(fake_redis).get("k", now=0.0) is None


def test_redis_cooldown_fail_open_on_outage(fake_redis):
    store = RedisCooldownStore(fake_redis)
    fake_redis.fail = True
    assert store.get("k", now=0.0) is None
    store.set("k", StoredSlot(5.0, 5.0, "header"), now=0.0)  # must not raise
    store.clear("k")  # must not raise


# --- 单回合计费 claim -----------------------------------------------------------


def test_redis_turn_claim_is_shared_between_gates(fake_redis):
    first = _TurnClaimGate(
        ttl_seconds=60, store=RedisTurnClaimStore(fake_redis, ttl_seconds=60)
    )
    second = _TurnClaimGate(
        ttl_seconds=60, store=RedisTurnClaimStore(fake_redis, ttl_seconds=60)
    )
    assert not second.already_claimed("u1:turn-a", now=0.0)
    first.claim("u1:turn-a", now=0.0)
    assert second.already_claimed("u1:turn-a", now=1.0)
    assert not second.already_claimed("u1:turn-b", now=1.0)
    call = fake_redis.set_calls[0]
    assert call["name"] == f"{CLAIM_KEY_PREFIX}u1:turn-a"
    assert call["nx"] is True
    assert call["ex"] == 60


@pytest.mark.asyncio
async def test_shared_claim_charges_one_ticket_across_processes(monkeypatch, fake_redis):
    """两个 gate 共用 Redis：同 message_id 的多次代理调用只扣一张票。"""
    monkeypatch.setattr(
        "agentcore.conversation.inference_rate_limit.settings.rate_limit_enabled",
        True,
    )
    monkeypatch.setattr(
        "agentcore.conversation.rate_limit.settings.rate_limit_enabled", True
    )
    monkeypatch.setattr(
        "agentcore.conversation.rate_limit.settings.user_message_rate_limit_max", 20
    )
    limiter = SlidingWindowRateLimiter(max_requests=1, window_seconds=60.0)
    gate_a = _TurnClaimGate(
        ttl_seconds=60, store=RedisTurnClaimStore(fake_redis, ttl_seconds=60)
    )
    gate_b = _TurnClaimGate(
        ttl_seconds=60, store=RedisTurnClaimStore(fake_redis, ttl_seconds=60)
    )
    await enforce_inference_proxy_rate_limit(
        "u1", message_id="turn-a", limiter=limiter, turn_claims=gate_a, now=0.0
    )
    # 落到「另一个进程」若无共享 claim，这里会第二次 check 并 429。
    await enforce_inference_proxy_rate_limit(
        "u1", message_id="turn-a", limiter=limiter, turn_claims=gate_b, now=1.0
    )
    with pytest.raises(RateLimitedError):
        await enforce_inference_proxy_rate_limit(
            "u1", message_id="turn-b", limiter=limiter, turn_claims=gate_b, now=2.0
        )


def test_turn_claim_redis_outage_falls_back_to_local_not_to_open(fake_redis):
    """Redis 挂了不能变成「放行」——本地记账仍要守住同一个回合只扣一次。"""
    store = RedisTurnClaimStore(fake_redis, ttl_seconds=60)
    fake_redis.fail = True
    assert store.has("u1:turn-a", now=0.0) is False
    store.add("u1:turn-a", now=0.0)
    assert store.has("u1:turn-a", now=1.0) is True
    assert store.has("u1:turn-b", now=1.0) is False


def test_turn_claim_ttl_expires(fake_redis):
    store = RedisTurnClaimStore(fake_redis, ttl_seconds=2)
    store.add("u1:turn-a", now=0.0)
    assert store.has("u1:turn-a", now=1.0) is True
    # FakeRedis 不自己走时间，直接把 key 拿掉模拟 EX 到期。
    fake_redis.delete(f"{CLAIM_KEY_PREFIX}u1:turn-a")
    assert store.has("u1:turn-a", now=3.0) is False
