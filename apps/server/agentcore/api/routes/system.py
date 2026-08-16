"""System routes: liveness/readiness probes and build provenance.

The probes follow the Kubernetes convention so an orchestrator / load balancer
acts on the right signal:

- ``GET /livez`` — *liveness*: is the process up and serving HTTP at all? It
  touches no external dependency, so a transient database outage never trips it
  into a restart loop. Always ``200``.
- ``GET /readyz`` — *readiness*: can the service actually handle requests right
  now? HTTP 200/503 is decided solely by PostgreSQL (``database_ready``). Redis
  (rate-limit backend) is probed as a soft dependency: when
  ``rate_limit_backend=redis`` the body still includes ``redis``, but a Redis
  failure does **not** flip the status to ``503`` (limiters fail-open / degrade).
- ``GET /version`` — build provenance (semantic version + git SHA + build time)
  for traceability and instant rollback.
- ``GET /updates/policy`` — desktop auto-update remote circuit breaker + hard
  floor. The desktop updater polls it before each check;
  ``enabled: false`` is a kill switch for a bad release; ``min_desktop_version``
  is the hard floor (client forced-update gate + server ``CLIENT_TOO_OLD`` API
  gate). Unauthenticated and dependency-free like ``/version`` so outdated
  clients can still fetch policy pre-login; kill switch is **fail-open**.

The desktop client probes ``/readyz`` on startup to tell an infrastructure
outage (e.g. the database is down) apart from a normal unauthenticated state, so
it can show an actionable "service unavailable" screen instead of a login form
that would fail anyway.
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, Field

from agentcore.cache.redis_health import redis_ready
from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import database_ready
from agentcore.observability.stream_timing import elapsed_ms, mono_now

router = APIRouter(tags=["system"])
logger = get_logger(__name__)

# Last HTTP readiness outcome. Success is logged only on transition so K8s
# probes (every few seconds) do not flood jsonl. not_ready: first hit always,
# then at most one heartbeat per ``_READYZ_FAIL_INTERVAL_S`` (same posture as
# backpressure drops — do not lose onset, do not replay db.ping_failed storms).
_last_readyz_ok: bool | None = None
_readyz_fail_unlogged = 0
_readyz_last_fail_log_mono: float | None = None
_READYZ_FAIL_INTERVAL_S = 10.0


class UpdatesPolicyResponse(BaseModel):
    """Desktop update policy: kill switch + hard minimum client version."""

    # Desktop-only by design. The native mobile floor (MOBILE_MIN_VERSION, 发布与门禁
    # §7.6a) is deliberately absent: the Android shell discovers versions from the
    # brand CDN android/latest.json and never calls this endpoint, so a field here
    # would have no reader. Outdated native clients learn their floor from the 426
    # body's details.min_version instead.

    enabled: bool
    min_desktop_version: str | None = Field(
        default=None,
        description=(
            "Semver hard floor for desktop; null when unset "
            "(no forced-update gate / no CLIENT_TOO_OLD API gate)."
        ),
    )


@router.get("/livez")
async def liveness() -> dict[str, str]:
    """Liveness probe: the process is up. Deliberately checks no dependencies."""
    return {"status": "alive"}


@router.get("/readyz")
async def readiness(response: Response) -> dict[str, object]:
    """Readiness probe: HTTP 200/503 follows DB only; Redis is observational.

    PostgreSQL is the hard dependency that decides ``ready`` / ``not_ready``
    (and thus 200 vs 503). Redis is a soft dependency for distributed rate
    limiting: still probed and, when ``rate_limit_backend=redis``, written to
    ``body["redis"]`` for ops/alerting; a Redis outage must not return 503.
    """
    t0 = mono_now()
    db_ok = await database_ready()
    redis_ok = await redis_ready()
    probe_ms = elapsed_ms(t0)
    ready = db_ok
    if not ready:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    body: dict[str, object] = {
        "status": "ready" if ready else "not_ready",
        "database": db_ok,
    }
    if settings.rate_limit_backend == "redis":
        body["redis"] = redis_ok
    _log_readyz(ready=ready, db_ok=db_ok, redis_ok=redis_ok, probe_ms=probe_ms)
    return body


def _log_readyz(*, ready: bool, db_ok: bool, redis_ok: bool, probe_ms: int) -> None:
    """First not_ready + 10s heartbeat; ready only on first probe or recovery."""
    global _last_readyz_ok, _readyz_fail_unlogged, _readyz_last_fail_log_mono
    fields: dict[str, object] = {
        "ok": ready,
        "status": "ready" if ready else "not_ready",
        "database": db_ok,
        "probe_ms": probe_ms,
    }
    if settings.rate_limit_backend == "redis":
        fields["redis"] = redis_ok
    prev = _last_readyz_ok
    now = mono_now()
    if not ready:
        first = prev is not False
        if first:
            _readyz_fail_unlogged = 0
            _readyz_last_fail_log_mono = now
            _last_readyz_ok = False
            logger.warning("http.readyz_failed", fail_count=1, **fields)
            return
        _readyz_fail_unlogged += 1
        last = _readyz_last_fail_log_mono
        if last is None or (now - last) >= _READYZ_FAIL_INTERVAL_S:
            fields["fail_count"] = _readyz_fail_unlogged
            _readyz_fail_unlogged = 0
            _readyz_last_fail_log_mono = now
            logger.warning("http.readyz_failed", **fields)
        _last_readyz_ok = False
        return
    _last_readyz_ok = True
    if prev is None or prev is False:
        if _readyz_fail_unlogged:
            fields["unlogged_failures"] = _readyz_fail_unlogged
        _readyz_fail_unlogged = 0
        _readyz_last_fail_log_mono = None
        logger.info("http.readyz", **fields)


def app_version() -> str:
    """Semantic version from installed package metadata (single source: pyproject).

    Public so the admin system panel (管理员后台 P2) reports the same version the
    ``/version`` probe does — one provenance source.
    """
    try:
        return _package_version("agentcore")
    except PackageNotFoundError:  # running from a tree that was never installed
        return "unknown"


@router.get("/version")
async def version() -> dict[str, str]:
    """Build provenance for traceability: semantic version + git SHA + build time."""
    return {
        "version": app_version(),
        "git_sha": settings.git_sha,
        "built_at": settings.built_at,
    }


@router.get("/updates/policy", response_model=UpdatesPolicyResponse)
async def updates_policy() -> UpdatesPolicyResponse:
    """Desktop auto-update policy (发布与门禁.md §7.6).

    The desktop updater polls this before each check and pauses downloads when
    ``enabled`` is false — a kill switch for a bad release. ``min_desktop_version``
    is the hard floor: clients force update when older, and the server rejects
    ``X-Client-Platform=desktop`` business APIs below it with ``CLIENT_TOO_OLD``
    (HTTP 426). Empty ``DESKTOP_MIN_VERSION`` → ``min_desktop_version: null``
    (dev-friendly; no gate). This endpoint itself is exempt from the API gate so
    outdated clients can still learn the floor.

    Unauthenticated and dependency-free (like ``/version``) so the updater can
    reach it pre-login. The kill-switch client is **fail-open**: any error or
    non-200 is treated as enabled.

    Staged rollout (stagingPercentage) and beta/stable channels ride on the
    feature-flag system (发布与门禁.md §7.9) and are not part of this payload yet.
    Per-flag ``min_client_version`` (§7.9) remains a separate line from this
    global desktop floor.
    """
    raw = settings.desktop_min_version.strip()
    return UpdatesPolicyResponse(
        enabled=settings.desktop_updates_enabled,
        min_desktop_version=raw or None,
    )
