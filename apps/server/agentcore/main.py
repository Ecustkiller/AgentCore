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
    autonomy,
    boards,
    bookmarks,
    capabilities,
    conversations,
    devices,
    favicon,
    feedback,
    files,
    folders,
    inference,
    llm_key,
    memory,
    messages,
    realtime,
    search,
    sharing,
    simulation,
    system,
    usage,
    users,
    workspaces,
)
from agentcore.auth.retention import refresh_token_retention_loop
from agentcore.config import settings
from agentcore.conversation.compaction import shutdown_compaction
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import setup_logging
from agentcore.db.migration_check import check_migrations
from agentcore.memory.consolidation import consolidation_loop, shutdown_scheduler
from agentcore.middleware.csrf import CsrfMiddleware
from agentcore.middleware.errors import JSONErrorMiddleware
from agentcore.middleware.rate_limit import AuthRateLimitMiddleware
from agentcore.runtime.audit_retention import audit_retention_loop
from agentcore.runtime.session_retention import session_retention_loop
from agentcore.runtime.suspension_retention import paused_turn_retention_loop
from agentcore.security.keys import KeyEncryptor
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
    # The code-execution tool class (code_execute AND test_run — a test suite runs
    # arbitrary project code through the SAME sandbox chain) on a cloud/server worker
    # runs untrusted model/user code. With GVISOR_ENABLED the runsc sandbox provides a
    # real isolation boundary; without it, execution is a plain subprocess INSIDE the
    # API container — no namespace/seccomp/rlimit/egress isolation, so it is effectively
    # authenticated RCE with access to JWT_SECRET_KEY / ENCRYPTION_KEY and every user's
    # encrypted keys. The whole class is default-off on cloud and gated by the SAME
    # config here (both withheld from the worker registry via code_execution_enabled_for),
    # but a single CODE_EXECUTE_CLOUD_ENABLED flip would silently expose it; require a
    # second, explicitly-named acknowledgement so the unsafe config can't be reached by
    # accident (SEC-005).
    if (
        settings.code_execute_cloud_enabled
        and not settings.gvisor_enabled
        and not settings.code_execute_cloud_unsafe_ack
    ):
        raise RuntimeError(
            "CODE_EXECUTE_CLOUD_ENABLED=true runs untrusted code in a plain subprocess "
            "inside the API container — NOT an isolation boundary (authenticated RCE with "
            "access to in-process secrets). Keep it off (recommended; local/sidecar "
            "workers still run code), enable GVISOR_ENABLED=true for a real sandbox, "
            "or — only without gVisor — set "
            "CODE_EXECUTE_CLOUD_UNSAFE_ACK=true to acknowledge the risk explicitly."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    setup_logging()
    _validate_production_security()
    if settings.gvisor_enabled:
        from agentcore.tools.sandbox.gvisor import GVisorSandbox

        gvisor = GVisorSandbox(
            runsc_path=settings.gvisor_runsc_path,
            runtime_root=settings.gvisor_runtime_root,
        )
        if not await gvisor.health_check():
            raise RuntimeError(
                "GVISOR_ENABLED=true but runsc is not available — install gVisor "
                "runsc or disable GVISOR_ENABLED."
            )
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

    audit_retention_task: asyncio.Task | None = None
    audit_retention_task = asyncio.create_task(audit_retention_loop())

    refresh_token_retention_task = asyncio.create_task(refresh_token_retention_loop())

    # Paused-turn TTL sweep (结构化挂起 2b): prune paused_turns frames abandoned past
    # the 7-day window so durable suspensions stay bounded. The live resolve path drops
    # connected pauses; this only catches the disconnected, never-resumed remainder.
    paused_turn_retention_task: asyncio.Task | None = None
    if settings.structured_suspension_persist_enabled:
        paused_turn_retention_task = asyncio.create_task(paused_turn_retention_loop())

    # Durable RUNNING lease sweeper (crash recover): claim heartbeat-expired leases and
    # redrive unfinished DAG via recover_turn. Boot pass runs inside the loop.
    turn_lease_sweep_task: asyncio.Task | None = None
    if settings.turn_lease_enabled:
        from agentcore.runtime.leases import turn_lease_sweep_loop

        turn_lease_sweep_task = asyncio.create_task(turn_lease_sweep_loop())

    # Cost ledger durable drain (as-built: 成本配额 §三): proxy spend always
    # enqueues; turn/handoff enqueue on sync write failure. Consumer writes
    # cost_events on the telemetry pool. Single-process only — multi-worker
    # needs Redis/DB outbox.
    from agentcore.billing.cost_ledger_queue import get_cost_ledger_queue

    cost_ledger_queue = get_cost_ledger_queue()
    cost_ledger_queue.start()

    try:
        yield
    finally:
        await cost_ledger_queue.stop()
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
        if audit_retention_task is not None:
            audit_retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await audit_retention_task
        refresh_token_retention_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await refresh_token_retention_task
        if paused_turn_retention_task is not None:
            paused_turn_retention_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await paused_turn_retention_task
        if turn_lease_sweep_task is not None:
            turn_lease_sweep_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await turn_lease_sweep_task
        # Flush in-flight debounced passes and cancel pending timers.
        await shutdown_scheduler()
        # Flush in-flight long-conversation compaction folds.
        await shutdown_compaction()
        # Release the shared SearXNG keep-alive pool.
        await aclose_search_backend()


app = FastAPI(
    title="AgentCore",
    description="Multi-Agent AI Workspace API",
    version=system.app_version(),
    lifespan=lifespan,
)

# Middleware runs outermost-last-added: register the rate limiter first so CORS
# wraps it and even a 429 response carries the CORS headers the browser needs.
app.add_middleware(CsrfMiddleware)
app.add_middleware(AuthRateLimitMiddleware)
# Added just before CORS so it sits *inside* the CORS layer: an unhandled error
# (anything not an AgentCoreError, e.g. a raw DB error) becomes a JSON 500 that
# still flows back out through CORSMiddleware and gets the CORS headers — instead
# of Starlette's outermost bare 500 that lacks them and surfaces as a misleading
# CORS/network error in the browser.
app.add_middleware(JSONErrorMiddleware)
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
app.include_router(autonomy.router, prefix="/v1")
app.include_router(boards.router, prefix="/v1")
app.include_router(bookmarks.router, prefix="/v1")
app.include_router(capabilities.router, prefix="/v1")
app.include_router(conversations.router, prefix="/v1")
app.include_router(devices.router, prefix="/v1")
app.include_router(favicon.router, prefix="/v1")
app.include_router(feedback.router, prefix="/v1")
app.include_router(files.router, prefix="/v1")
app.include_router(folders.router, prefix="/v1")
app.include_router(inference.router, prefix="/v1")
app.include_router(llm_key.router, prefix="/v1")
app.include_router(memory.router, prefix="/v1")
app.include_router(messages.router, prefix="/v1")
app.include_router(realtime.router, prefix="/v1")
app.include_router(search.router, prefix="/v1")
app.include_router(simulation.router, prefix="/v1")
# Conversation sharing (分享对话): owner-only manage under /v1, plus the public
# read-only page at the root (/shared/{token}, no /v1, no auth).
app.include_router(sharing.router, prefix="/v1")
app.include_router(sharing.public_router)
app.include_router(usage.router, prefix="/v1")
app.include_router(users.router, prefix="/v1")
app.include_router(workspaces.router, prefix="/v1")
