"""Process-wide Redis client factory (project house-style).

Mirrors ``storage/factory.py``: one place builds the client from
``settings.redis_url``, cached with ``lru_cache`` so the connection pool is
shared across rate limiters, soft ``/readyz`` redis observation, and future callers.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

from agentcore.config import settings

# Event-loop bound: the API is a single uvicorn process. A sync Redis call with
# no socket timeout can freeze every in-flight SSE stream and ``/readyz``.
# Local Redis RTT is milliseconds; these are hang/partition ceilings, not
# latency targets. Rate-limit I/O fail-opens on timeout (see redis_rate_limit).
REDIS_SOCKET_CONNECT_TIMEOUT_S = 1.0
REDIS_SOCKET_TIMEOUT_S = 1.0


@lru_cache(maxsize=1)
def get_redis_client() -> Any:
    """Return the process-wide Redis client chosen by configuration.

    ``decode_responses=False`` matches rate-limiter key/member handling (bytes).
    Does not ping — connectivity checks belong at construct (``redis_client``)
    or the soft ``/readyz`` body probe (``redis_ready``; does not decide HTTP 503).
    Connect and read/write each have a hard socket ceiling so a wedged Redis
    cannot block the event loop without bound.
    """
    import redis

    return redis.Redis.from_url(
        settings.redis_url,
        decode_responses=False,
        socket_connect_timeout=REDIS_SOCKET_CONNECT_TIMEOUT_S,
        socket_timeout=REDIS_SOCKET_TIMEOUT_S,
        # redis-py 8 retries TimeoutError 10× by default — a 1s hang becomes ~10s
        # on the event loop. ``retry=None`` → Connection uses Retry(..., 0).
        retry=None,
    )


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
