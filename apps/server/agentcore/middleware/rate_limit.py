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
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Protocol

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


@dataclass(frozen=True)
class RateLimitDecision:
    """Outcome of a limiter check. ``retry_after`` is the seconds until the next
    slot frees (``0`` when allowed)."""

    allowed: bool
    retry_after: float = 0.0


class RateLimiter(Protocol):
    """Swappable limiter seam (成本配额与计费.md §一). The in-memory impl below is
    single-process; a Redis ZSET impl can replace it for multiple workers without
    touching call sites."""

    def check(self, key: str, *, now: float | None = None) -> RateLimitDecision: ...

    def reset(self) -> None: ...


class SlidingWindowRateLimiter:
    """Per-key sliding window: at most ``max_requests`` hits within any trailing
    ``window_seconds``.

    Unlike a fixed window, this has no boundary burst (a fixed window can let ~2x
    the cap straddle the reset instant). Keeps a deque of hit timestamps per key,
    evicting those older than the window on each check. A blocked call is **not**
    recorded, so a client that keeps hammering while throttled can't push its own
    reset further out. State is process-local (single server process) — front with
    a Redis ZSET to scale to multiple workers.
    """

    def __init__(self, *, max_requests: int, window_seconds: float) -> None:
        self._max = max_requests
        self._window = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str, *, now: float | None = None) -> RateLimitDecision:
        """Record an allowed hit for ``key`` and return the decision."""
        now = time.monotonic() if now is None else now
        hits = self._hits[key]
        cutoff = now - self._window
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if len(hits) >= self._max:
            retry_after = hits[0] + self._window - now
            return RateLimitDecision(allowed=False, retry_after=max(0.0, retry_after))
        hits.append(now)
        return RateLimitDecision(allowed=True)

    def reset(self) -> None:
        self._hits.clear()


# Module-level singletons sized from settings; exposed so tests can reset state.
auth_rate_limiter = FixedWindowRateLimiter(
    max_requests=settings.auth_rate_limit_max,
    window_seconds=settings.auth_rate_limit_window_seconds,
)
# Per-user message-send limiter, consulted in the conversation routes via
# agentcore.conversation.rate_limit.enforce_user_message_rate_limit.
message_rate_limiter = SlidingWindowRateLimiter(
    max_requests=settings.user_message_rate_limit_max,
    window_seconds=settings.user_message_rate_limit_window_seconds,
)


def reset_rate_limit_state() -> None:
    """Clear all counters (test isolation between cases)."""
    auth_rate_limiter.reset()
    message_rate_limiter.reset()


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
