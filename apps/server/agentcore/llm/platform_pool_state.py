"""Replaceable runtime state for the platform credential pool.

Cooling / exhausted / blocked flags and conversation stickiness live here,
not on the Postgres member rows. Redis is the shared backend (same toggle as
rate limiting); a single replica falls back to process memory. Callers talk
only to :class:`PoolStateStore` so the backend can change without touching
the scheduler.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Literal, Protocol

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

AccountStatus = Literal["healthy", "degraded", "cooling", "exhausted", "blocked"]

_KEY_PREFIX = "ac:ppool:"
_STICKY_TTL_SECONDS = 7 * 24 * 3600
_STORE: PoolStateStore | None = None


@dataclass(frozen=True, slots=True)
class AccountRecord:
    """Runtime posture of one pool member. ``healthy`` is represented by absence."""

    status: AccountStatus
    recovery_at: float | None
    limit_name: str | None
    source: str


class PoolStateStore(Protocol):
    def get(self, account_id: str) -> AccountRecord | None: ...

    def set(self, account_id: str, record: AccountRecord) -> None: ...

    def clear(self, account_id: str) -> None: ...

    def get_sticky(self, task_id: str) -> str | None: ...

    def set_sticky(self, task_id: str, account_id: str) -> None: ...

    def reset(self) -> None: ...


class _RedisCommands(Protocol):
    """redis-py subset this store actually calls (sync client, bytes values)."""

    def get(self, name: str) -> object: ...

    def set(self, name: str, value: bytes, ex: int | None = None) -> object: ...

    def delete(self, name: str) -> object: ...


def _expired(record: AccountRecord, *, now: float) -> bool:
    if record.status == "blocked":
        return False
    if record.recovery_at is None:
        return record.status != "blocked"
    return record.recovery_at <= now


class MemoryPoolStateStore:
    """Process-local maps. Fine for one API replica; tests always use this."""

    def __init__(self) -> None:
        self._accounts: dict[str, AccountRecord] = {}
        self._sticky: dict[str, str] = {}

    def get(self, account_id: str) -> AccountRecord | None:
        record = self._accounts.get(account_id)
        if record is None:
            return None
        if _expired(record, now=time.time()):
            self._accounts.pop(account_id, None)
            return None
        return record

    def set(self, account_id: str, record: AccountRecord) -> None:
        self._accounts[account_id] = record

    def clear(self, account_id: str) -> None:
        self._accounts.pop(account_id, None)

    def get_sticky(self, task_id: str) -> str | None:
        return self._sticky.get(task_id)

    def set_sticky(self, task_id: str, account_id: str) -> None:
        self._sticky[task_id] = account_id

    def reset(self) -> None:
        self._accounts.clear()
        self._sticky.clear()


class RedisPoolStateStore:
    """Shared account state. Each op fail-opens to 'no record' on Redis errors."""

    def __init__(self, client: _RedisCommands) -> None:
        self._client = client

    def _acct_key(self, account_id: str) -> str:
        return f"{_KEY_PREFIX}acct:{account_id}"

    def _sticky_key(self, task_id: str) -> str:
        return f"{_KEY_PREFIX}sticky:{task_id}"

    def _decode(self, raw: object) -> dict | None:
        if raw is None:
            return None
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        return data if isinstance(data, dict) else None

    def _fail_open(self, exc: Exception, *, op: str) -> None:
        logger.warning("platform_pool.redis_fail_open", op=op, error=str(exc))

    def get(self, account_id: str) -> AccountRecord | None:
        try:
            raw = self._client.get(self._acct_key(account_id))
        except Exception as e:  # noqa: BLE001 — fail-open: look like healthy
            self._fail_open(e, op="get")
            return None
        data = self._decode(raw)
        if data is None:
            return None
        status = data.get("status")
        if status not in {"degraded", "cooling", "exhausted", "blocked"}:
            return None
        recovery_at = data.get("recovery_at")
        recovery = float(recovery_at) if isinstance(recovery_at, (int, float)) else None
        record = AccountRecord(
            status=status,
            recovery_at=recovery,
            limit_name=data.get("limit_name") if isinstance(data.get("limit_name"), str) else None,
            source=str(data.get("source") or ""),
        )
        if _expired(record, now=time.time()):
            self.clear(account_id)
            return None
        return record

    def set(self, account_id: str, record: AccountRecord) -> None:
        payload = json.dumps(
            {
                "status": record.status,
                "recovery_at": record.recovery_at,
                "limit_name": record.limit_name,
                "source": record.source,
            },
            separators=(",", ":"),
        ).encode()
        key = self._acct_key(account_id)
        try:
            if record.status == "blocked":
                self._client.set(key, payload)
                return
            now = time.time()
            ttl = 1
            if record.recovery_at is not None and record.recovery_at > now:
                ttl = max(1, int(record.recovery_at - now) + 1)
            self._client.set(key, payload, ex=ttl)
        except Exception as e:  # noqa: BLE001
            self._fail_open(e, op="set")

    def clear(self, account_id: str) -> None:
        try:
            self._client.delete(self._acct_key(account_id))
        except Exception as e:  # noqa: BLE001
            self._fail_open(e, op="clear")

    def get_sticky(self, task_id: str) -> str | None:
        try:
            raw = self._client.get(self._sticky_key(task_id))
        except Exception as e:  # noqa: BLE001
            self._fail_open(e, op="get_sticky")
            return None
        if raw is None:
            return None
        text = (
            raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        ).strip()
        return text or None

    def set_sticky(self, task_id: str, account_id: str) -> None:
        try:
            self._client.set(
                self._sticky_key(task_id),
                account_id.encode(),
                ex=_STICKY_TTL_SECONDS,
            )
        except Exception as e:  # noqa: BLE001
            self._fail_open(e, op="set_sticky")

    def reset(self) -> None:
        # Tests should not point this store at a live Redis; no SCAN wipe.
        return


def _build_store() -> PoolStateStore:
    from agentcore.config import settings

    if settings.rate_limit_backend == "redis":
        try:
            from agentcore.cache.redis import redis_client

            return RedisPoolStateStore(redis_client())
        except Exception as e:  # noqa: BLE001 — same fail-open as rate limiters
            logger.warning(
                "platform_pool.redis_fail_open",
                op="construct",
                error=str(e),
            )
    return MemoryPoolStateStore()


def get_pool_state_store() -> PoolStateStore:
    """Process-wide store (built once; tests call :func:`reset_pool_state_store`)."""
    global _STORE
    if _STORE is None:
        _STORE = _build_store()
    return _STORE


def reset_pool_state_store() -> None:
    """Drop every slot and the cached backend (tests + admin re-enable)."""
    global _STORE
    if _STORE is not None:
        _STORE.reset()
    _STORE = None


def override_pool_state_store(store: PoolStateStore | None) -> None:
    """Tests: inject a store (``None`` restores lazy construct)."""
    global _STORE
    _STORE = store
