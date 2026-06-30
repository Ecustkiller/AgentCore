"""DB-backed save / claim / delete for paused turns (结构化挂起 2b turn 级落盘).

Bridges the DB-unaware ``delegate`` checkpoint hook + the resume entry point to the
``paused_turns`` table. The pipeline wires :func:`save_paused_turn` / :func:`delete_paused_turn`
into ``delegate`` (persist a frame before the wait; drop it after a live in-process
resolve), and ``resume_chat`` calls :func:`claim_paused_turn` (atomic read-and-delete,
so a turn is never resumed twice) + :func:`list_paused_turns` (a conversation's pending
frames on reopen). Uses ``async_session_factory`` directly (not an injected request
session), matching the cost-ledger / session-roster persistence posture.

The paused turn's journal-so-far rides the ``turn_journal`` table (唯一事实源, §8.3),
NOT the frame: :func:`save_paused_turn` mirrors it there and :func:`claim_paused_turn`
re-hydrates it, so the replay stream has a single home whether the turn is paused or
completed.

Saves are best-effort: a persistence failure logs and degrades to 2a in-memory
behaviour (the live resolve still works; only the durable backstop is lost) rather
than breaking the user's turn. The save MUST happen before the suspend ``await`` so a
disconnect/crash during the wait still leaves a resumable frame.
"""

from __future__ import annotations

from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import PausedTurnRepository, TurnJournalRepository
from agentcore.push import PushNotification, notify_user
from agentcore.runtime.journal import runs_from_entries
from agentcore.runtime.suspension import (
    SuspensionKind,
    TurnSuspension,
    suspension_from_json,
)

logger = get_logger(__name__)


async def save_paused_turn(suspension: TurnSuspension) -> None:
    """Persist one paused-turn frame, keyed by its ``message_id`` (best-effort).

    Stamps the ambient turn ``trace_id`` (this runs inside the pipeline's trace
    scope) so the persisted pause links back to its originating turn's logs.
    Upsert: re-pausing the same turn (resume → pause again) overwrites in place.
    The journal-so-far is NOT in the frame — it is mirrored into ``turn_journal``
    (唯一事实源, §8.3) by :func:`_save_pause_journal`.
    """
    trace_id = suspension.trace_id or get_log_value("trace_id") or None
    try:
        async with async_session_factory() as db:
            await PausedTurnRepository(db).upsert(
                message_id=suspension.message_id,
                conversation_id=suspension.conversation_id,
                user_id=suspension.user_id,
                frame=suspension.to_json(),
                trace_id=trace_id,
            )
    except Exception as e:  # noqa: BLE001 — persistence must never break the turn
        logger.warning(
            "suspension.persist_failed",
            message_id=suspension.message_id,
            error=str(e),
        )
        return
    # The frame is committed and alone makes the turn resumable; now mirror the
    # journal-so-far as a SEPARATE best-effort write so its failure can never roll
    # back the frame. A lost journal only costs the graph replay on reload.
    await _save_pause_journal(suspension, trace_id)
    # A durable pause is the canonical 需要你 (attention) event: the turn is now BLOCKED
    # on the user and stays so until they act. Fan a native push out to their devices so
    # they learn even with the app backgrounded (SSE gone). Best-effort + default-off
    # (notify_user short-circuits when push is unconfigured) — never blocks the pause.
    await _notify_pause(suspension)


async def _notify_pause(suspension: TurnSuspension) -> None:
    """Push a 需要你 notification for a durable pause (best-effort, default-off).

    Copy is keyed by the suspend kind; the ``data`` carries the ids the mobile client
    deep-links on tap (conversation + the paused turn). ``notify_user`` itself swallows
    all errors, so this never affects the pause.
    """
    if suspension.kind == SuspensionKind.PLAN_REVIEW:
        title = "AI 计划待确认"
        body = "团队已产出阶段成果，待你确认是否继续。"
    else:
        title = "AI 需要你的回应"
        question = (getattr(suspension, "question", "") or "").strip()
        body = question[:120] if question else "AI 正在等待你的回应以继续任务。"
    await notify_user(
        suspension.user_id,
        PushNotification(
            title=title,
            body=body,
            data={
                "conversation_id": suspension.conversation_id,
                "message_id": suspension.message_id,
                "kind": suspension.kind.value,
            },
        ),
    )


async def _save_pause_journal(suspension: TurnSuspension, trace_id: str | None) -> None:
    """Record a paused turn's journal-so-far to ``turn_journal`` (唯一事实源, best-effort).

    Keyed by the same ``message_id`` the resumed turn reuses, so the resume hydrates
    it back (:func:`claim_paused_turn`) and the completed turn re-records it wholesale
    (``record`` replaces). Re-pausing (resume → pause again) replaces the cumulative
    stream. A failure logs and degrades — never breaks the pause.

    Persists the §8.3 fact-log stream (:attr:`TurnSuspension.journal_entries` — the
    suspending face's ``current_fact_log`` snapshot: execution facts interleaved with
    forwarded display facts) so the paused journal is ``window_from_journal``-rebuildable
    for resume.
    """
    entries = list(suspension.journal_entries)
    if not entries:
        return
    try:
        async with async_session_factory() as db:
            await TurnJournalRepository(db).record(
                turn_id=suspension.message_id,
                conversation_id=suspension.conversation_id,
                trace_id=trace_id,
                entries=entries,
            )
    except Exception as e:  # noqa: BLE001 — journal persistence must never break the turn
        logger.warning(
            "suspension.journal_persist_failed",
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

    The journal-so-far is re-hydrated from ``turn_journal`` (唯一事实源, it is not in
    the frame) onto :attr:`TurnSuspension.journal`, so the resume seeds + replays the
    whole pre-pause graph. The raw loaded stream is ALSO carried onto
    :attr:`TurnSuspension.journal_entries` (the §8.3 fact-log stream, incl. the execution
    facts the display projection drops): the resume folds it via ``window_from_journal`` to
    rebuild the captain window (执行级事件溯源 Phase 2 ④/⑤ — the window is a projection of the
    journal, no longer read from a frame ``transcript`` blob, which is no longer serialized).
    The window's prior-turn history is reloaded separately from the message DB by the
    caller (``service.resume_chat``) and threaded in. The stored rows are left in place: the
    resumed turn re-records them wholesale on completion (or the TTL sweep clears them if the
    turn is abandoned).
    """
    try:
        async with async_session_factory() as db:
            row = await PausedTurnRepository(db).claim(message_id, conversation_id=conversation_id)
            if row is None:
                return None
            suspension = suspension_from_json(row.frame)
            entries = await TurnJournalRepository(db).load(message_id)
    except Exception as e:  # noqa: BLE001 — a claim failure reads as "not resumable"
        logger.warning("suspension.claim_failed", message_id=message_id, error=str(e))
        return None
    # Raw stream (execution facts + display) for the Phase 2 window rebuild; the display
    # seed (events only) for the unchanged resume read path.
    suspension.journal_entries = list(entries or [])
    runs = runs_from_entries(entries)
    suspension.journal = list((runs or {}).get("events") or [])
    return suspension


async def list_paused_turns(conversation_id: str) -> list[TurnSuspension]:
    """A conversation's pending paused turns (oldest first), for reopen-time hydration.

    Read-only (does not claim); the resume call claims. Best-effort: an error yields an
    empty list so reopening a conversation never fails on a paused-turn lookup.
    """
    try:
        async with async_session_factory() as db:
            rows = await PausedTurnRepository(db).list_pending(conversation_id)
    except Exception as e:  # noqa: BLE001 — a list failure degrades to "none pending"
        logger.warning("suspension.list_failed", conversation_id=conversation_id, error=str(e))
        return []
    return [suspension_from_json(r.frame) for r in rows]
