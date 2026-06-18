"""System routes: liveness/readiness probes and build provenance.

The probes follow the Kubernetes convention so an orchestrator / load balancer
acts on the right signal:

- ``GET /livez`` — *liveness*: is the process up and serving HTTP at all? It
  touches no external dependency, so a transient database outage never trips it
  into a restart loop. Always ``200``.
- ``GET /readyz`` — *readiness*: can the service actually handle requests right
  now? It exercises every hard dependency (currently PostgreSQL via the shared
  ``database_ready`` probe) and returns ``503`` when one is unreachable, so
  traffic is held back until recovery.
- ``GET /version`` — build provenance (semantic version + git SHA + build time)
  for traceability and instant rollback.

The desktop client probes ``/readyz`` on startup to tell an infrastructure
outage (e.g. the database is down) apart from a normal unauthenticated state, so
it can show an actionable "service unavailable" screen instead of a login form
that would fail anyway.
"""

from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as _package_version

from fastapi import APIRouter, Response, status

from agentcore.config import settings
from agentcore.db.base import database_ready

router = APIRouter(tags=["system"])


@router.get("/livez")
async def liveness() -> dict[str, str]:
    """Liveness probe: the process is up. Deliberately checks no dependencies."""
    return {"status": "alive"}


@router.get("/readyz")
async def readiness(response: Response) -> dict[str, object]:
    """Readiness probe: 200 when every hard dependency is reachable, else 503."""
    db_ok = await database_ready()
    if not db_ok:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return {"status": "ready" if db_ok else "not_ready", "database": db_ok}


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
