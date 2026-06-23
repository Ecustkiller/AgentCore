"""FastAPI application entry point."""

import asyncio
import contextlib
import logging
import math
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agentcore.api.routes import (
    admin,
    auth,
    capabilities,
    conversations,
    devices,
    favicon,
    files,
    folders,
    inference,
    llm_key,
    messages,
    realtime,
    search,
    sharing,
    system,
    tools,
    usage,
    users,
    workspaces,
)
from agentcore.config import settings
from agentcore.conversation.compaction import shutdown_compaction
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import setup_logging
from agentcore.db.migration_check import check_migrations
from agentcore.memory.consolidation import consolidation_loop, shutdown_scheduler
from agentcore.middleware.csrf import CsrfMiddleware
from agentcore.middleware.rate_limit import AuthRateLimitMiddleware
from agentcore.runtime.session_retention import session_retention_loop
from agentcore.runtime.suspension_retention import paused_turn_retention_loop
from agentcore.security import KeyEncryptor
from agentcore.tools.builtin.web.search_backend import (
    aclose_search_backend,
    probe_search_at_startup,
)
from agentcore.workspace.retention import retention_loop

logger = logging.getLogger(__name__)

# Known placeholder secrets that must never reach production.
_INSECURE_SECRETS = {
    "",
    "dev-secret-change-in-production",
    "change-this-to-a-random-secret-in-production",
}


def _validate_production_security() -> None:
    """Fail fast on insecure production config (skipped in debug)."""
    if settings.debug:
        return
    if settings.jwt_secret_key in _INSECURE_SECRETS:
        raise RuntimeError(
            "JWT_SECRET_KEY is unset or still a default placeholder. Set a strong, "
            "random secret before running in production (DEBUG=false)."
        )
    # byok makes a per-user API key mandatory, so a usable master key is required
    # to store it. Without one the model-config page can't save a key and every
    # turn is blocked — fail closed at boot rather than ship a server that looks
    # healthy (livez/readyz green) but can't chat (安全权限与治理.md §七).
    if settings.billing_mode == "byok":
        if not settings.encryption_key:
            raise RuntimeError(
                "ENCRYPTION_KEY is unset but billing_mode=byok requires it (users "
                "store their own API key, encrypted at rest). Generate one: "
                'python -c "import secrets; print(secrets.token_hex(32))".'
            )
        try:
            KeyEncryptor(settings.encryption_key)
        except ValueError as exc:
            raise RuntimeError(
                "ENCRYPTION_KEY is malformed (must be 64 hex chars = 32 bytes); "
                "byok billing cannot encrypt user keys without a valid master key."
            ) from exc
    if not settings.cookie_secure:
        logger.warning(
            "security.cookie_insecure",
            detail="COOKIE_SECURE is false in a non-debug run: auth cookies may "
            "travel over plain HTTP; set COOKIE_SECURE=true when serving over HTTPS",
        )
    # SameSite=None is required for the cross-site desktop (app://) → API cookie to
    # ride credentialed requests, but browsers silently drop a None cookie that
    # isn't also Secure — fail closed rather than ship broken desktop auth.
    if settings.cookie_samesite.lower() == "none" and not settings.cookie_secure:
        raise RuntimeError(
            "COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browsers drop a "
            "SameSite=None cookie without Secure). Set COOKIE_SECURE=true."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    _validate_production_security()
    # Schema-drift notice: warn loudly (never block) if the live DB is behind the
    # migration head, so an unapplied migration surfaces at boot instead of as a
    # mid-session UndefinedColumnError on a core endpoint.
    await check_migrations()

    # Background retention sweep (决策⑦): physically purge soft-deleted workspaces
    # past their grace period. Best-effort and self-contained; cancelled cleanly
    # on shutdown. Disabled config → no task.
    retention_task: asyncio.Task | None = None
    if settings.workspace_retention_enabled:
        retention_task = asyncio.create_task(retention_loop())

    # Long-term-memory consolidation backstop (Agent记忆 §1.5): periodically sweep
    # settled conversations whose latest message is past the watermark and fold them
    # into the user's memory — covers a debounce dropped by a restart / closed
    # client. The live path is the per-turn idle debounce (memory/consolidation.py).
    consolidation_task: asyncio.Task | None = None
    if settings.memory_consolidation_enabled:
        consolidation_task = asyncio.create_task(consolidation_loop())

    # Dev-experience: log SearXNG ✓/✗ at boot so a not-started search dependency is
    # visible immediately instead of only surfacing mid-run as a breaker message. The
    # probe also runs a one-shot real-search canary when reachable, so a healthz-200-but-
    # every-engine-CAPTCHA SearXNG (the production failure mode) is visible at boot too.
    # Fire-and-forget — bounded by the probe's own short timeout and never blocks or
    # fails startup (web_search just degrades while SearXNG is down).
    searxng_probe_task = asyncio.create_task(probe_search_at_startup())

    # Recoverable-worker roster TTL sweep (留人 跨进程落盘 P3): prune run_sessions
    # rows idle past the 7-day window so the durable roster stays bounded.
    session_retention_task: asyncio.Task | None = None
    if settings.session_roster_persist_enabled:
        session_retention_task = asyncio.create_task(session_retention_loop())

    # Paused-turn TTL sweep (结构化挂起 2b): prune paused_turns frames abandoned past
    # the 7-day window so durable suspensions stay bounded. The live resolve path drops
    # connected pauses; this only catches the disconnected, never-resumed remainder.
    paused_turn_retention_task: asyncio.Task | None = None
    if settings.structured_suspension_persist_enabled:
        paused_turn_retention_task = asyncio.create_task(paused_turn_retention_loop())

    try:
        yield
    finally:
        # Stop the boot probe if shutdown races its short window (no-op once done).
        searxng_probe_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await searxng_probe_task
        if retention_task is not None:
            retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await retention_task
        if consolidation_task is not None:
            consolidation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consolidation_task
        if session_retention_task is not None:
            session_retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await session_retention_task
        if paused_turn_retention_task is not None:
            paused_turn_retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await paused_turn_retention_task
        # Flush in-flight debounced passes and cancel pending timers.
        await shutdown_scheduler()
        # Flush in-flight long-conversation compaction folds.
        await shutdown_compaction()
        # Release the shared SearXNG keep-alive pool.
        await aclose_search_backend()


app = FastAPI(
    title="AgentCore",
    description="Multi-Agent AI Workspace API",
    version="0.1.0",
    lifespan=lifespan,
)

# Middleware runs outermost-last-added: register the rate limiter first so CORS
# wraps it and even a 429 response carries the CORS headers the browser needs.
app.add_middleware(CsrfMiddleware)
app.add_middleware(AuthRateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Downloads (导出对话 / workspace zips) carry the filename in Content-Disposition;
    # browsers hide non-simple response headers cross-origin unless explicitly exposed,
    # so the renderer can read the server's sanitized UTF-8 filename instead of guessing.
    expose_headers=["Content-Disposition", "X-CSRF-Token"],
)


@app.exception_handler(AgentCoreError)
async def agentcore_error_handler(request, exc: AgentCoreError):
    from fastapi.responses import JSONResponse

    # Surface Retry-After on errors that carry a cool-down (e.g. RateLimitedError),
    # whole seconds per RFC 7231, rounded up so the client never retries early.
    headers: dict[str, str] | None = None
    retry_after = getattr(exc, "retry_after", None)
    if retry_after is not None and retry_after > 0:
        headers = {"Retry-After": str(math.ceil(retry_after))}

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers=headers,
    )


app.include_router(system.router)
app.include_router(admin.router, prefix="/v1")
app.include_router(auth.router, prefix="/v1")
app.include_router(capabilities.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")
app.include_router(devices.router, prefix="/v1")
app.include_router(favicon.router, prefix="/v1")
app.include_router(files.router, prefix="/v1")
app.include_router(folders.router, prefix="/v1")
app.include_router(inference.router, prefix="/v1")
app.include_router(llm_key.router, prefix="/v1")
app.include_router(messages.router, prefix="/v1")
app.include_router(realtime.router, prefix="/v1")
app.include_router(search.router, prefix="/v1")
# Conversation sharing (分享对话): owner-only manage under /v1, plus the public
# read-only page at the root (/shared/{token}, no /v1, no auth).
app.include_router(sharing.router, prefix="/v1")
app.include_router(sharing.public_router)
app.include_router(tools.router, prefix="/v1")
app.include_router(usage.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(workspaces.router, prefix="/v1")
