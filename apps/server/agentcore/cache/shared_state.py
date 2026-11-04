"""Replaceable backends for two process-local state seams.

生成 / 最后修订 2026-11-04。口径见 ``config/shared_state.py``：**本模块不改变
多 worker 拒启**，也没有任何「解锁实例数」的开关；默认 ``memory`` 与上游逐位
等价，``redis`` 只是把两处已接受 skew 的状态做成可共享。

两处状态的时钟域不一样，所以都用**相对剩余时间 / TTL**，绝不把
``time.monotonic()`` 的绝对值写进 Redis（那在别的进程里没有可比基准）：

- 冷却槽：Redis 存 ``{seconds, source}`` + ``EX``，读时用 ``PTTL`` 换算剩余；
- 计费 claim：Redis 存 ``SET NX EX``，与推理令牌同寿命自动过期。

同步 Redis 客户端有 1s socket ceiling（``cache/redis.py``）。每个操作自行
fail-open：读失败当「无槽 / 未认领」，写失败只告警；计费 claim 额外退回本地
内存记账，避免 Redis 一抖就变成限流缺口（少扣方向会被滥用）。
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from typing import Protocol

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

COOLDOWN_KEY_PREFIX = "ac:shared:cooldown:"
CLAIM_KEY_PREFIX = "ac:shared:turnclaim:"

SHARED_STATE_CAPABILITIES = {
    "default_backend": "memory",
    "multi_worker_still_refused": True,
    "startup_validation_untouched": True,
    "cross_process_event_fanout": False,
    "cooldown_uses_relative_ttl": True,
    "turn_claim_cross_process_toctou_removed": False,
    "redis_read_failure": "fail-open (behave like an empty slot / unclaimed)",
    "redis_write_failure": "warn; turn claim falls back to local memory",
    "declares_multi_instance_ready": False,
}


class _RedisCommands(Protocol):
    """redis-py subset these stores call (sync client, bytes values)."""

    def get(self, name: str) -> object: ...

    def set(
        self, name: str, value: bytes, ex: int | None = None, nx: bool = False
    ) -> object: ...

    def delete(self, name: str) -> object: ...

    def pttl(self, name: str) -> object: ...

    def exists(self, name: str) -> object: ...


def _fail_open(exc: Exception, *, op: str) -> None:
    logger.warning("shared_state.redis_fail_open", op=op, error=str(exc))


# --- 429 cooldown -------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class StoredSlot:
    """A live cooldown expressed as *remaining* seconds, not an absolute clock."""

    remaining: float
    seconds: float
    source: str


class CooldownStore(Protocol):
    def get(self, key: str, *, now: float) -> StoredSlot | None: ...

    def set(self, key: str, slot: StoredSlot, *, now: float) -> None: ...

    def clear(self, key: str) -> None: ...

    def reset(self) -> None: ...


class MemoryCooldownStore:
    """逐行照搬原 ``_slots`` 语义（单调时钟 + 惰性过期）；默认后端。"""

    def __init__(self) -> None:
        self._slots: dict[str, tuple[float, float, str]] = {}

    def get(self, key: str, *, now: float) -> StoredSlot | None:
        entry = self._slots.get(key)
        if entry is None:
            return None
        recovery_at, seconds, source = entry
        remaining = recovery_at - now
        if remaining <= 0:
            self._slots.pop(key, None)
            return None
        return StoredSlot(remaining=remaining, seconds=seconds, source=source)

    def set(self, key: str, slot: StoredSlot, *, now: float) -> None:
        self._slots[key] = (now + slot.remaining, slot.seconds, slot.source)

    def clear(self, key: str) -> None:
        self._slots.pop(key, None)

    def reset(self) -> None:
        self._slots.clear()


def _decode_slot(raw: object) -> tuple[float, str] | None:
    if raw is None:
        return None
    text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    seconds = data.get("seconds")
    source = data.get("source")
    if not isinstance(seconds, (int, float)) or not isinstance(source, str):
        return None
    return float(seconds), source


def _remaining_seconds(pttl: object) -> float | None:
    """PTTL is milliseconds; -2 = missing, -1 = no expiry (we always set EX)."""
    if not isinstance(pttl, (int, float)) or isinstance(pttl, bool):
        return None
    ms = float(pttl)
    if ms <= 0:
        return None
    return ms / 1000.0


class RedisCooldownStore:
    """Shared 429 slots. A dead Redis behaves like an empty local slot table."""

    def __init__(self, client: _RedisCommands) -> None:
        self._client = client

    @staticmethod
    def _key(key: str) -> str:
        return f"{COOLDOWN_KEY_PREFIX}{key}"

    def get(self, key: str, *, now: float) -> StoredSlot | None:
        del now  # Redis owns expiry via PTTL; no monotonic clock crosses processes.
        name = self._key(key)
        try:
            raw = self._client.get(name)
            if raw is None:
                return None
            remaining = _remaining_seconds(self._client.pttl(name))
        except Exception as e:  # noqa: BLE001 — fail-open: look like an open slot
            _fail_open(e, op="cooldown.get")
            return None
        if remaining is None:
            return None
        decoded = _decode_slot(raw)
        if decoded is None:
            return None
        seconds, source = decoded
        return StoredSlot(remaining=remaining, seconds=seconds, source=source)

    def set(self, key: str, slot: StoredSlot, *, now: float) -> None:
        del now
        payload = json.dumps(
            {"seconds": slot.seconds, "source": slot.source}, separators=(",", ":")
        ).encode()
        ttl = max(1, math.ceil(slot.remaining))
        try:
            self._client.set(self._key(key), payload, ex=ttl)
        except Exception as e:  # noqa: BLE001 — never reject a call because Redis died
            _fail_open(e, op="cooldown.set")

    def clear(self, key: str) -> None:
        try:
            self._client.delete(self._key(key))
        except Exception as e:  # noqa: BLE001
            _fail_open(e, op="cooldown.clear")

    def reset(self) -> None:
        # No SCAN wipe — tests must not point this store at a live Redis.
        return


def build_cooldown_store() -> CooldownStore:
    from agentcore.config import settings

    if settings.llm_cooldown_backend == "redis":
        try:
            from agentcore.cache.redis import redis_client

            return RedisCooldownStore(redis_client())
        except Exception as e:  # noqa: BLE001 — same fail-open as the rate limiters
            _fail_open(e, op="cooldown.construct")
    return MemoryCooldownStore()


# --- once-per-turn rate ticket claim ------------------------------------------


class TurnClaimStore(Protocol):
    def has(self, key: str, *, now: float) -> bool: ...

    def add(self, key: str, *, now: float) -> None: ...

    def reset(self) -> None: ...


class MemoryTurnClaimStore:
    """原 ``_claimed`` 语义：单调时钟时间戳 + TTL 惰性清理 + 10k 上限回收。"""

    def __init__(self, *, ttl_seconds: float) -> None:
        self._ttl = ttl_seconds
        self._claimed: dict[str, float] = {}

    def has(self, key: str, *, now: float) -> bool:
        ts = self._claimed.get(key)
        if ts is None:
            return False
        if now - ts >= self._ttl:
            del self._claimed[key]
            return False
        return True

    def add(self, key: str, *, now: float) -> None:
        self._claimed[key] = now
        if len(self._claimed) > 10_000:
            cutoff = now - self._ttl
            self._claimed = {k: t for k, t in self._claimed.items() if t > cutoff}

    def reset(self) -> None:
        self._claimed.clear()


class RedisTurnClaimStore:
    """Shared claim via ``SET NX EX``; Redis failure falls back to local memory.

    ``has`` 先看本地兜底再查 Redis；``add`` 写 Redis 失败时补写本地，这样一次
    Redis 抖动不会让同一回合在后续调用里被反复扣票。
    """

    def __init__(self, client: _RedisCommands, *, ttl_seconds: float) -> None:
        self._client = client
        self._ttl = max(1, math.ceil(ttl_seconds))
        self._fallback = MemoryTurnClaimStore(ttl_seconds=ttl_seconds)

    @staticmethod
    def _key(key: str) -> str:
        return f"{CLAIM_KEY_PREFIX}{key}"

    def has(self, key: str, *, now: float) -> bool:
        if self._fallback.has(key, now=now):
            return True
        try:
            return bool(self._client.exists(self._key(key)))
        except Exception as e:  # noqa: BLE001 — fall back to the local result
            _fail_open(e, op="claim.exists")
            return False

    def add(self, key: str, *, now: float) -> None:
        try:
            self._client.set(self._key(key), b"1", ex=self._ttl, nx=True)
        except Exception as e:  # noqa: BLE001
            _fail_open(e, op="claim.set")
            # 不能「Redis 挂了就放行」——那等于拆掉限流，改由本地记账兜住。
            self._fallback.add(key, now=now)

    def reset(self) -> None:
        self._fallback.reset()
        # No SCAN wipe (same reason as RedisCooldownStore).
        return


def build_turn_claim_store(*, ttl_seconds: float) -> TurnClaimStore:
    from agentcore.config import settings

    if settings.inference_turn_claim_backend == "redis":
        try:
            from agentcore.cache.redis import redis_client

            return RedisTurnClaimStore(redis_client(), ttl_seconds=ttl_seconds)
        except Exception as e:  # noqa: BLE001
            _fail_open(e, op="claim.construct")
    return MemoryTurnClaimStore(ttl_seconds=ttl_seconds)
