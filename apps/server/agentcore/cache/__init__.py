"""Shared Redis client seam (rate limit / readiness; future callers welcome).

``get_redis_client`` / ``redis_client`` / ``redis_ready`` are the public surface.
Add a business-cache Protocol only when a real consumer lands.
"""

from agentcore.cache.redis import get_redis_client, redis_client
from agentcore.cache.redis_health import redis_ready

__all__ = [
    "get_redis_client",
    "redis_client",
    "redis_ready",
]
