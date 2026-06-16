"""DB-backed load / save for the 留人 roster (乙 热修 P3 跨进程落盘).

Bridges the DB-unaware roster + tools to the ``run_sessions`` table. The pipeline
wires these closures into ``delegate`` (write-through after a worker finishes) and
``revise`` (load-on-miss + write-through after a revision), so neither tool nor the
pipeline imports the DB layer. Uses ``async_session_factory`` directly (not an
injected request session), matching the cost-ledger / sweeper persistence posture.

All operations are best-effort: a persistence failure logs and degrades to P2
in-memory behaviour (a miss → 回落甲) rather than breaking the user's turn.
"""

from __future__ import annotations

from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import RunSessionRepository
from agentcore.runtime.runs.serialize import session_from_row, session_to_row
from agentcore.runtime.runs.session import RunSession

logger = get_logger(__name__)


async def save_run_session(conversation_id: str, session: RunSession) -> None:
    """Write-through persist one recoverable session (best-effort).

    Stamps the ambient turn ``trace_id`` (this runs inside the pipeline's trace
    scope, so contextvars carry it) so the persisted worker links back to its
    originating interaction's logs.
    """
    row = session_to_row(session)
    try:
        async with async_session_factory() as db:
            await RunSessionRepository(db).upsert(
                conversation_id=conversation_id,
                trace_id=get_log_value("trace_id") or None,
                **row,
            )
    except Exception as e:  # noqa: BLE001 — persistence must never break the turn
        logger.warning("session.persist_failed", run_id=session.run_id, error=str(e))


async def load_run_session(run_id: str) -> RunSession | None:
    """Rehydrate a persisted session by ``run_id`` (best-effort); ``None`` on miss
    or error (→ 回落甲 at the call site)."""
    try:
        async with async_session_factory() as db:
            row = await RunSessionRepository(db).get(run_id)
    except Exception as e:  # noqa: BLE001 — a load failure degrades to a roster miss
        logger.warning("session.load_failed", run_id=run_id, error=str(e))
        return None
    return session_from_row(row) if row is not None else None
