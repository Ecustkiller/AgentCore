"""Process-wide Redis client factory (project house-style).

Mirrors ``storage/factory.py``: one place builds the client from
``settings.redis_url``, cached with ``lru_cache`` so the connection pool is
shared across rate limiters, soft ``/readyz`` redis observation, and future callers.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from agentcore.config import settings


@lru_cache(maxsize=1)
def get_redis_client() -> Any:
    """Return the process-wide Redis client chosen by configuration.

    ``decode_responses=False`` matches rate-limiter key/member handling (bytes).
    Does not ping — connectivity checks belong at construct (``redis_client``)
    or the soft ``/readyz`` body probe (``redis_ready``; does not decide HTTP 503).
    """
    import redis

    return redis.Redis.from_url(settings.redis_url, decode_responses=False)


def redis_client() -> Any:
    """Shared client after a connectivity check (construct-time / explicit probe).

    Rate-limit builders call this so a dead Redis at boot fails open to the
    in-memory bucket (``security.rate_limit_redis_fallback``). Readyz pings via
    ``get_redis_client`` without going through this wrapper so construct and
    probe stay distinct call sites.
    """
    client = get_redis_client()
    client.ping()
    return client
