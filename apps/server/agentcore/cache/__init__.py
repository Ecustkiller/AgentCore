"""Redis connectivity + optional cache Protocol skeleton (M15).

``get_redis_client`` / ``redis_client`` are the shared client seam. ``CacheBackend``
is a minimal Protocol only — no Redis-backed business cache is forced here.
"""

from agentcore.cache.protocol import CacheBackend
from agentcore.cache.redis import get_redis_client, redis_client
from agentcore.cache.redis_health import redis_ready

__all__ = [
    "CacheBackend",
    "get_redis_client",
    "redis_client",
    "redis_ready",
]
