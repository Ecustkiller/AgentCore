"""Redis connectivity probe for ``/readyz`` body observation (soft dependency).

Does **not** decide HTTP readiness: ``/readyz`` returns 503 only when
PostgreSQL is down. Callers still surface ``redis`` in the probe body when
``rate_limit_backend=redis``.
"""

from __future__ import annotations

import asyncio

from agentcore.cache.redis import get_redis_client
from agentcore.config import settings
from agentcore.core.logging import get_logger

logger = get_logger(__name__)

_REDIS_PROBE_TIMEOUT_S = 2.0


async def redis_ready() -> bool:
    """Return whether Redis is reachable when ``rate_limit_backend=redis``.

    Soft dependency for ``/readyz``: a ``False`` result is observational only
    (body field / ``redis.probe_failed`` log), not a 503 trigger. When the
    backend is ``memory``, Redis is unused and this returns ``True``.
    Uses the process-wide client (``get_redis_client``) — does not open a new
    connection per probe.
    """
    if settings.rate_limit_backend != "redis":
        return True
    try:

        def _ping() -> bool:
            return bool(get_redis_client().ping())

        return await asyncio.wait_for(
            asyncio.to_thread(_ping),
            timeout=_REDIS_PROBE_TIMEOUT_S,
        )
    except Exception as exc:
        logger.warning("redis.probe_failed", error=str(exc))
        return False
