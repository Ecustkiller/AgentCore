"""Request rate limiting middleware.

A small in-memory fixed-window limiter for the auth endpoints (login, register,
refresh) to blunt credential-stuffing and registration spam on the public net.
Per-account lockout already lives in the auth service; this adds per-IP throttling
across accounts.

State is process-local, so it assumes a single server process — front with Redis
if you scale to multiple workers. The core ``FixedWindowRateLimiter`` is framework
-free and unit-tested directly; the middleware is the thin ASGI adapter.
"""

import time
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from agentcore.config import settings


class FixedWindowRateLimiter:
    """Count requests per key within a fixed window; block once the cap is hit."""

    def __init__(self, *, max_requests: int, window_seconds: float) -> None:
        self._max = max_requests
        self._window = window_seconds
        self._hits: dict[str, tuple[float, int]] = {}

    def allow(self, key: str, *, now: float | None = None) -> bool:
        """Record a hit for ``key``; return False once it exceeds the window cap."""
        now = time.monotonic() if now is None else now
        start, count = self._hits.get(key, (now, 0))
        if now - start >= self._window:
            start, count = now, 0
        count += 1
        self._hits[key] = (start, count)
        return count <= self._max

    def reset(self) -> None:
        self._hits.clear()


# Module-level singleton sized from settings; exposed so tests can reset state.
auth_rate_limiter = FixedWindowRateLimiter(
    max_requests=settings.auth_rate_limit_max,
    window_seconds=settings.auth_rate_limit_window_seconds,
)


def reset_rate_limit_state() -> None:
    """Clear all counters (test isolation between cases)."""
    auth_rate_limiter.reset()


def _client_key(request: Request) -> str:
    if settings.trust_proxy:
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    client = request.client
    return client.host if client else "unknown"


class AuthRateLimitMiddleware(BaseHTTPMiddleware):
    """Throttle POSTs under the auth path prefix per client IP."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        limiter: FixedWindowRateLimiter | None = None,
        path_prefix: str = "/v1/auth/",
    ) -> None:
        super().__init__(app)
        self._limiter = limiter or auth_rate_limiter
        self._path_prefix = path_prefix

    async def dispatch(
        self, request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        throttled = (
            settings.rate_limit_enabled
            and request.method == "POST"
            and request.url.path.startswith(self._path_prefix)
        )
        if throttled and not self._limiter.allow(_client_key(request)):
            return JSONResponse(
                status_code=429,
                content={
                    "error": {
                        "code": "RATE_LIMITED",
                        "message": "Too many requests. Slow down and retry shortly.",
                    }
                },
                headers={"Retry-After": str(int(settings.auth_rate_limit_window_seconds))},
            )
        return await call_next(request)
