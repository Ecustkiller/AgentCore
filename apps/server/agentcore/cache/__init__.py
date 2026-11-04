"""Shared Redis client seam (rate limit / readiness; future callers welcome).

``get_redis_client`` / ``redis_client`` / ``redis_ready`` are the public surface.
真正的业务状态消费者已落在 ``cache/shared_state.py``（429 冷却槽 / 单回合计费
claim 的可替换后端，默认内存、opt-in Redis）；它们刻意不从这里 re-export，
避免包 import 期就把配置与 Redis 客户端拉进来。
"""

from agentcore.cache.redis import get_redis_client, redis_client
from agentcore.cache.redis_health import redis_ready

__all__ = [
    "get_redis_client",
    "redis_client",
    "redis_ready",
]
