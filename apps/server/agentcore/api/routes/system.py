"""System routes: liveness/readiness probes and build provenance.

The probes follow the Kubernetes convention so an orchestrator / load balancer
acts on the right signal:

- ``GET /livez`` — *liveness*: is the process up and serving HTTP at all? It
  touches no external dependency, so a transient database outage never trips it
  into a restart loop. Always ``200``.
- ``GET /readyz`` — *readiness*: can the service actually handle requests right
  now? It exercises every hard dependency (currently PostgreSQL) and returns
  ``503`` when one is unreachable, so traffic is held back until recovery.
- ``GET /version`` — build provenance (semantic version + git SHA + build time)
  for traceability and instant rollback.

The desktop client probes ``/readyz`` on startup to tell an infrastructure
outage (e.g. the database is down) apart from a normal unauthenticated state, so
it can show an actionable "service unavailable" screen instead of a login form
that would fail anyway.
"""

import asyncio
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version

from fastapi import APIRouter, Response, status
from sqlalchemy import text

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory

logger = get_logger(__name__)

router = APIRouter(tags=["system"])

# Keep the probe snappy: a refused connection fails instantly, but a dropped /
# firewalled DB host would otherwise hang the request until the driver timeout.
_DB_PROBE_TIMEOUT_S = 3.0


async def _database_ready() -> bool:
    """Return True iff a trivial query against the database round-trips in time."""
    try:
        async with async_session_factory() as session:
            await asyncio.wait_for(session.execute(text("SELECT 1")), _DB_PROBE_TIMEOUT_S)
        return True
    except Exception:  # noqa: BLE001 - any failure means "not ready", reason is logged
        logger.warning("system.readiness_db_unreachable", exc_info=True)
        return False


@router.get("/livez")
async def liveness() -> dict[str, str]:
    """Liveness probe: the process is up. Deliberately checks no dependencies."""
    return {"status": "alive"}


@router.get("/readyz")
async def readiness(response: Response) -> dict[str, object]:
    """Readiness probe: 200 when every hard dependency is reachable, else 503."""
    db_ok = await _database_ready()
    if not db_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if db_ok else "not_ready", "database": db_ok}


def _app_version() -> str:
    """Semantic version from installed package metadata (single source: pyproject)."""
    try:
        return _package_version("agentcore")
    except PackageNotFoundError:  # running from a tree that was never installed
        return "unknown"


@router.get("/version")
async def version() -> dict[str, str]:
    """Build provenance for traceability: semantic version + git SHA + build time."""
    return {
        "version": _app_version(),
        "git_sha": settings.git_sha,
        "built_at": settings.built_at,
    }
