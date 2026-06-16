"""DB-backed save / claim / delete for paused turns (结构化挂起 2b turn 级落盘).

Bridges the DB-unaware ``delegate`` checkpoint hook + the resume entry point to the
``paused_turns`` table. The pipeline wires :func:`save_paused_turn` / :func:`delete_paused_turn`
into ``delegate`` (persist a frame before the wait; drop it after a live in-process
resolve), and ``resume_chat`` calls :func:`claim_paused_turn` (atomic read-and-delete,
so a turn is never resumed twice) + :func:`list_paused_turns` (a conversation's pending
frames on reopen). Uses ``async_session_factory`` directly (not an injected request
session), matching the cost-ledger / session-roster persistence posture.

Saves are best-effort: a persistence failure logs and degrades to 2a in-memory
behaviour (the live resolve still works; only the durable backstop is lost) rather
than breaking the user's turn. The save MUST happen before the suspend ``await`` so a
disconnect/crash during the wait still leaves a resumable frame.
"""

from __future__ import annotations

from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import PausedTurnRepository
from agentcore.runtime.suspension import TurnSuspension, suspension_from_json

logger = get_logger(__name__)


async def save_paused_turn(suspension: TurnSuspension) -> None:
    """Persist one paused-turn frame, keyed by its ``message_id`` (best-effort).

    Stamps the ambient turn ``trace_id`` (this runs inside the pipeline's trace
    scope) so the persisted pause links back to its originating turn's logs.
    Upsert: re-pausing the same turn (resume → pause again) overwrites in place.
    """
    try:
        async with async_session_factory() as db:
            await PausedTurnRepository(db).upsert(
                message_id=suspension.message_id,
                conversation_id=suspension.conversation_id,
                user_id=suspension.user_id,
                frame=suspension.to_json(),
                trace_id=suspension.trace_id or get_log_value("trace_id") or None,
            )
    except Exception as e:  # noqa: BLE001 — persistence must never break the turn
        logger.warning(
            "suspension.persist_failed",
            message_id=suspension.message_id,
            error=str(e),
        )


async def delete_paused_turn(message_id: str) -> None:
    """Drop a paused-turn frame (a live in-process resolve / timeout settled it).

    Best-effort: a stale frame left by a failed delete is harmless — ``claim`` would
    only resurrect a turn the user can re-decide, and the next live resolve overwrites
    it. NEVER raises into the turn.
    """
    try:
        async with async_session_factory() as db:
            await PausedTurnRepository(db).delete(message_id)
    except Exception as e:  # noqa: BLE001 — cleanup must never break the turn
        logger.warning("suspension.delete_failed", message_id=message_id, error=str(e))


async def claim_paused_turn(
    message_id: str, *, conversation_id: str | None = None
) -> TurnSuspension | None:
    """Atomically read-and-delete a paused turn for resume; ``None`` if already
    claimed / absent / unreadable.

    The atomic claim (DELETE ... RETURNING) means two racing ``/resume`` calls can't
    both continue the same turn — the loser gets ``None`` (→ 404 at the route). Pass
    ``conversation_id`` (the one the route verified the caller owns) so a frame is only
    claimed within that conversation (IDOR-safe). A load error degrades to ``None``
    (the route reports「已处理或不存在」) rather than raising.
    """
    try:
        async with async_session_factory() as db:
            row = await PausedTurnRepository(db).claim(
                message_id, conversation_id=conversation_id
            )
    except Exception as e:  # noqa: BLE001 — a claim failure reads as "not resumable"
        logger.warning("suspension.claim_failed", message_id=message_id, error=str(e))
        return None
    return suspension_from_json(row.frame) if row is not None else None


async def list_paused_turns(conversation_id: str) -> list[TurnSuspension]:
    """A conversation's pending paused turns (oldest first), for reopen-time hydration.

    Read-only (does not claim); the resume call claims. Best-effort: an error yields an
    empty list so reopening a conversation never fails on a paused-turn lookup.
    """
    try:
        async with async_session_factory() as db:
            rows = await PausedTurnRepository(db).list_pending(conversation_id)
    except Exception as e:  # noqa: BLE001 — a list failure degrades to "none pending"
        logger.warning(
            "suspension.list_failed", conversation_id=conversation_id, error=str(e)
        )
        return []
    return [suspension_from_json(r.frame) for r in rows]
