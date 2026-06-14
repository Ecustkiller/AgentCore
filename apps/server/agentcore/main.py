"""FastAPI application entry point."""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from agentcore.api.routes import auth, conversations, folders, system, tools, usage
from agentcore.config import settings
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import setup_logging
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

    try:
        yield
    finally:
        if retention_task is not None:
            retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await retention_task


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

    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
    )


app.include_router(system.router)
app.include_router(auth.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")
app.include_router(folders.router, prefix="/v1")
app.include_router(tools.router, prefix="/v1")
app.include_router(usage.router, prefix="/v1")
