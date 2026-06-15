"""FastAPI application entry point."""

import asyncio
import contextlib
import logging
import math
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agentcore.api.routes import (
    auth,
    conversations,
    folders,
    messages,
    realtime,
    system,
    tools,
    usage,
)
from agentcore.config import settings
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import setup_logging
from agentcore.memory.consolidation import consolidation_loop, shutdown_scheduler
from agentcore.middleware.rate_limit import AuthRateLimitMiddleware
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
    if not settings.cookie_secure:
        logger.warning(
            "COOKIE_SECURE is false in a non-debug run: auth cookies may travel over "
            "plain HTTP. Set COOKIE_SECURE=true when serving over HTTPS."
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
    setup_logging(debug=settings.debug)
    _validate_production_security()

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

    try:
        yield
    finally:
        if retention_task is not None:
            retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await retention_task
        if consolidation_task is not None:
            consolidation_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consolidation_task
        # Flush in-flight debounced passes and cancel pending timers.
        await shutdown_scheduler()


app = FastAPI(
    title="AgentCore",
    description="Multi-Agent AI Workspace API",
    version="0.1.0",
    lifespan=lifespan,
)

# Middleware runs outermost-last-added: register the rate limiter first so CORS
# wraps it and even a 429 response carries the CORS headers the browser needs.
app.add_middleware(AuthRateLimitMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
app.include_router(auth.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")
app.include_router(folders.router, prefix="/v1")
app.include_router(messages.router, prefix="/v1")
app.include_router(realtime.router, prefix="/v1")
app.include_router(tools.router, prefix="/v1")
app.include_router(usage.router, prefix="/v1")
