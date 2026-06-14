"""Unit tests for the auth rate limiter and its ASGI middleware."""

import httpx
from fastapi import FastAPI
from httpx import ASGITransport

from agentcore.middleware.rate_limit import (
    AuthRateLimitMiddleware,
    FixedWindowRateLimiter,
)

# --- core limiter ---


def test_allows_up_to_max_then_blocks():
    limiter = FixedWindowRateLimiter(max_requests=3, window_seconds=60)
    assert [limiter.allow("ip", now=0) for _ in range(3)] == [True, True, True]
    assert limiter.allow("ip", now=1) is False


def test_window_resets_after_elapsed():
    limiter = FixedWindowRateLimiter(max_requests=1, window_seconds=10)
    assert limiter.allow("ip", now=0) is True
    assert limiter.allow("ip", now=5) is False
    assert limiter.allow("ip", now=11) is True  # fresh window


def test_keys_are_independent():
    limiter = FixedWindowRateLimiter(max_requests=1, window_seconds=10)
    assert limiter.allow("a", now=0) is True
    assert limiter.allow("b", now=0) is True
    assert limiter.allow("a", now=0) is False


def test_reset_clears_counters():
    limiter = FixedWindowRateLimiter(max_requests=1, window_seconds=10)
    assert limiter.allow("ip", now=0) is True
    assert limiter.allow("ip", now=0) is False
    limiter.reset()
    assert limiter.allow("ip", now=0) is True


# --- middleware ---


def _app(limiter: FixedWindowRateLimiter) -> FastAPI:
    app = FastAPI()
    app.add_middleware(AuthRateLimitMiddleware, limiter=limiter)

    @app.post("/v1/auth/login")
    async def _login():
        return {"ok": True}

    @app.get("/v1/auth/me")
    async def _me():
        return {"ok": True}

    @app.post("/v1/conversations")
    async def _convos():
        return {"ok": True}

    return app


async def test_middleware_throttles_auth_posts():
    limiter = FixedWindowRateLimiter(max_requests=2, window_seconds=60)
    transport = ASGITransport(app=_app(limiter))
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        assert (await c.post("/v1/auth/login")).status_code == 200
        assert (await c.post("/v1/auth/login")).status_code == 200
        blocked = await c.post("/v1/auth/login")
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "RATE_LIMITED"
        assert blocked.headers.get("retry-after")


async def test_middleware_ignores_get_and_non_auth_paths():
    limiter = FixedWindowRateLimiter(max_requests=1, window_seconds=60)
    transport = ASGITransport(app=_app(limiter))
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        # GET under the auth prefix is not throttled (only POST is)...
        for _ in range(5):
            assert (await c.get("/v1/auth/me")).status_code == 200
        # ...and a non-auth POST is never throttled.
        for _ in range(5):
            assert (await c.post("/v1/conversations")).status_code == 200
