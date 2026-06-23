"""Rate limit helpers for inference-token minting."""

from __future__ import annotations

import math

from agentcore.config import settings
from agentcore.core.errors import RateLimitedError
from agentcore.middleware.rate_limit import RateLimiter, inference_token_mint_limiter


async def enforce_inference_token_mint_rate_limit(
    user_id: str,
    *,
    limiter: RateLimiter | None = None,
    now: float | None = None,
) -> None:
    """Raise :class:`RateLimitedError` if ``user_id`` mints inference tokens too fast."""
    if not settings.rate_limit_enabled or settings.inference_token_mint_max <= 0:
        return

    limiter = limiter or inference_token_mint_limiter
    decision = limiter.check(user_id, now=now)
    if not decision.allowed:
        retry_after = max(1, math.ceil(decision.retry_after))
        raise RateLimitedError(
            f"推理令牌申请过于频繁，请约 {retry_after} 秒后再试。",
            retry_after=decision.retry_after,
        )
