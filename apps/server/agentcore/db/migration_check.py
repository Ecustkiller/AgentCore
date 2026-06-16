"""Startup migration-drift check.

Compares the database's applied Alembic revision against the migration scripts'
head(s) and emits an actionable WARNING when they diverge — the classic
parallel-dev footgun where another worktree adds a model column plus its
migration, but the local dev database is never upgraded, so a query selecting the
new column 500s with ``UndefinedColumnError`` (the model in ``db/models.py`` and
the matching ``migrations/versions/`` script are ahead of the live schema).

This is a *notice*, not a gate: it never raises and never blocks startup — a
flaky check must not take the API down. The remediation is always the same: run
``uv run alembic upgrade head`` from ``apps/server``.
"""

from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Connection

import agentcore.db as _db_pkg
from agentcore.core.logging import get_logger
from agentcore.db.base import engine

logger = get_logger(__name__)

_UPGRADE_HINT = "run `uv run alembic upgrade head` from apps/server"


def _script_heads() -> set[str]:
    """Head revision(s) declared by the migration scripts (offline, reads files).

    Resolved from the package location rather than the cwd so the result is the
    same whether the server is launched from ``apps/server`` or elsewhere.
    """
    migrations_dir = Path(_db_pkg.__file__).resolve().parent / "migrations"
    cfg = Config()
    cfg.set_main_option("script_location", str(migrations_dir))
    return set(ScriptDirectory.from_config(cfg).get_heads())


def _db_heads(sync_conn: Connection) -> set[str]:
    """Revision(s) recorded in the database's ``alembic_version`` table.

    Returns an empty set when the table is absent (a schema never put under
    Alembic management).
    """
    return set(MigrationContext.configure(sync_conn).get_current_heads())


async def check_migrations() -> None:
    """Warn (never raise) when the DB schema diverges from the migration head.

    Surfaces three drift shapes:

    - DB behind / diverged from head — unapplied migration(s); the usual cause of
      ``UndefinedColumnError`` at runtime.
    - DB carries no Alembic version row — schema is not migration-managed.
    - Multiple script heads — branched migrations; ``upgrade head`` refuses until
      they are merged.
    """
    try:
        heads = _script_heads()
        async with engine.connect() as conn:
            current = await conn.run_sync(_db_heads)
    except Exception as exc:  # a flaky check must never break startup
        logger.warning("db.migration_check_failed", error=str(exc), exc_info=True)
        return

    if len(heads) > 1:
        logger.warning(
            "db.migrations_branched",
            heads=sorted(heads),
            detail="multiple migration heads — merge them before upgrading",
        )

    if not current:
        logger.warning(
            "db.migrations_unmanaged",
            heads=sorted(heads),
            detail=f"database has no Alembic version row; {_UPGRADE_HINT}",
        )
        return

    if current != heads:
        logger.warning(
            "db.migrations_pending",
            db=sorted(current),
            heads=sorted(heads),
            pending=sorted(heads - current),
            detail=f"database schema is behind the latest migration; {_UPGRADE_HINT}",
        )
        return

    logger.debug("db.migrations_ok", heads=sorted(heads))
