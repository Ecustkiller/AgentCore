"""Unit tests for inference-token mint rate limiting."""

import pytest

from agentcore.conversation.inference_rate_limit import enforce_inference_token_mint_rate_limit
from agentcore.core.errors import RateLimitedError
from agentcore.middleware.rate_limit import SlidingWindowRateLimiter


@pytest.mark.asyncio
async def test_inference_mint_rate_limit_blocks_after_cap(monkeypatch):
    monkeypatch.setattr(
        "agentcore.conversation.inference_rate_limit.settings.rate_limit_enabled",
        True,
    )
    monkeypatch.setattr(
        "agentcore.conversation.inference_rate_limit.settings.inference_token_mint_max",
        2,
    )
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=60.0)
    await enforce_inference_token_mint_rate_limit("u1", limiter=limiter, now=0.0)
    await enforce_inference_token_mint_rate_limit("u1", limiter=limiter, now=0.0)
    with pytest.raises(RateLimitedError):
        await enforce_inference_token_mint_rate_limit("u1", limiter=limiter, now=0.0)
