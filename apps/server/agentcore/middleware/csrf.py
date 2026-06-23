"""CSRF protection for cookie-authenticated clients (admin console, desktop).

Cross-origin SPAs cannot read an API-scoped double-submit cookie, so this uses a
**synchronizer token**: mint on login/refresh, return via ``X-CSRF-Token`` response
header (CORS-exposed), client echoes it on mutating requests. Bearer-token clients
(mobile) skip enforcement entirely.

State is keyed by ``user_id``; use Redis when ``rate_limit_backend=redis``.
"""

from __future__ import annotations

import secrets
from typing import Protocol

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

from agentcore.api.dependencies import ACCESS_TOKEN_COOKIE
from agentcore.config import settings
from agentcore.core.errors import AuthenticationError
from agentcore.security import decode_access_token, generate_csrf_token

CSRF_HEADER = "X-CSRF-Token"
CSRF_COOKIE = "csrf_token"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_EXEMPT_PREFIXES = (
    "/v1/auth/login",
    "/v1/auth/register",
    "/v1/auth/refresh",
    "/v1/auth/token",
    "/shared/",
)


class CsrfStore(Protocol):
    def set(self, user_id: str, token: str) -> None: ...

    def clear(self, user_id: str) -> None: ...

    def valid(self, user_id: str, token: str) -> bool: ...


class MemoryCsrfStore:
    def __init__(self) -> None:
        self._tokens: dict[str, str] = {}

    def set(self, user_id: str, token: str) -> None:
        self._tokens[user_id] = token

    def clear(self, user_id: str) -> None:
        self._tokens.pop(user_id, None)

    def valid(self, user_id: str, token: str) -> bool:
        stored = self._tokens.get(user_id)
        return stored is not None and secrets.compare_digest(stored, token)

    def reset(self) -> None:
        self._tokens.clear()


class RedisCsrfStore:
    def __init__(self, client) -> None:
        self._redis = client
        self._ttl = settings.jwt_refresh_token_expire_days * 86400

    def set(self, user_id: str, token: str) -> None:
        self._redis.setex(f"csrf:{user_id}", self._ttl, token)

    def clear(self, user_id: str) -> None:
        self._redis.delete(f"csrf:{user_id}")

    def valid(self, user_id: str, token: str) -> bool:
        stored = self._redis.get(f"csrf:{user_id}")
        if stored is None:
            return False
        if isinstance(stored, bytes):
            stored = stored.decode("utf-8")
        return secrets.compare_digest(stored, token)


_memory_csrf_store = MemoryCsrfStore()
_csrf_store: CsrfStore = _memory_csrf_store


def _build_csrf_store() -> CsrfStore:
    if settings.rate_limit_backend != "redis":
        return _memory_csrf_store
    try:
        import redis

        client = redis.Redis.from_url(settings.redis_url, decode_responses=True)
        client.ping()
        return RedisCsrfStore(client)
    except Exception:
        return _memory_csrf_store


csrf_store: CsrfStore = _build_csrf_store()


def reset_csrf_state() -> None:
    """Clear in-memory CSRF tokens (test isolation)."""
    if isinstance(_memory_csrf_store, MemoryCsrfStore):
        _memory_csrf_store.reset()


def issue_csrf_token(response: Response, user_id: str) -> str:
    """Mint a CSRF token for ``user_id`` and attach it to the login/refresh response."""
    token = generate_csrf_token()
    csrf_store.set(user_id, token)
    response.headers[CSRF_HEADER] = token
    response.set_cookie(
        key=CSRF_COOKIE,
        value=token,
        max_age=settings.jwt_refresh_token_expire_days * 86400,
        httponly=False,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )
    return token


def clear_csrf_token(response: Response, user_id: str | None) -> None:
    if user_id:
        csrf_store.clear(user_id)
    response.delete_cookie(CSRF_COOKIE, path="/")


def _bearer_present(request: Request) -> bool:
    auth = request.headers.get("authorization") or ""
    return auth.lower().startswith("bearer ")


def _csrf_user_id(request: Request) -> str | None:
    token = request.cookies.get(ACCESS_TOKEN_COOKIE)
    if not token:
        return None
    try:
        return decode_access_token(token)
    except AuthenticationError:
        return None


class CsrfMiddleware(BaseHTTPMiddleware):
    """Require ``X-CSRF-Token`` on cookie-session mutating requests."""

    async def dispatch(self, request: Request, call_next):
        if not settings.csrf_enabled:
            return await call_next(request)
        if request.method in _SAFE_METHODS:
            return await call_next(request)
        if any(request.url.path.startswith(p) for p in _EXEMPT_PREFIXES):
            return await call_next(request)
        if _bearer_present(request):
            return await call_next(request)
        user_id = _csrf_user_id(request)
        if user_id is None:
            return await call_next(request)

        header = request.headers.get(CSRF_HEADER) or ""
        if not header or not csrf_store.valid(user_id, header):
            return JSONResponse(
                status_code=403,
                content={
                    "error": {
                        "code": "CSRF_FAILED",
                        "message": "CSRF token missing or invalid. Re-login and retry.",
                    }
                },
            )
        return await call_next(request)
