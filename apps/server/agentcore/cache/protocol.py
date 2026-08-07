"""Minimal cache backend Protocol (skeleton only).

M15 converges Redis connectivity; business caches stay opt-in behind this
seam. No Redis-backed implementation is shipped here — callers that need a
shared client use ``get_redis_client`` directly (rate limit / health probe).
"""

from __future__ import annotations

from typing import Protocol


class CacheBackend(Protocol):
    """Byte-oriented key/value cache with optional TTL.

    Intentionally small: get / set / delete. Implementations may be in-process,
    Redis, or a no-op — this Protocol does not prescribe a backend.
    """

    def get(self, key: str) -> bytes | None:
        """Return the value for ``key``, or ``None`` on miss / expiry."""
        ...

    def set(self, key: str, value: bytes, *, ttl_seconds: float | None = None) -> None:
        """Store ``value`` under ``key``; ``ttl_seconds`` is optional expiry."""
        ...

    def delete(self, key: str) -> None:
        """Remove ``key`` (idempotent: missing key is not an error)."""
        ...
