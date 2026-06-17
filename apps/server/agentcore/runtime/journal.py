"""Turn Journal — persist a turn's execution fact stream and project it back.

The §18.3 Turn Journal is the唯一事实源 for a turn's execution: an append-only,
per-turn ordered stream of facts (run/tool/interaction events for a multi-agent
turn; reasoning/tool 步 for a single-agent turn; a closing ``turn_end``). It lives
in the ``turn_journal`` table (keyed by ``turn_id`` == the assistant ``message_id``)
and REPLACES the old ``messages.runs`` JSON blob.

「一切皆投影」(§18.3): nothing else stores the replay payload. The assistant
message's ``MessageDetail.runs`` is rebuilt from the journal on read via
:func:`runs_from_entries`; the write side flattens the in-memory sink payload to
journal entries via :func:`entries_from_runs`. The two are exact inverses, so a
turn round-trips through the journal unchanged.

This module owns the (pure) projection transforms + a best-effort persist helper.
Storage is the :class:`~agentcore.db.repositories.TurnJournalRepository` (the
§18.6 ``Journal`` port's Postgres implementation); a future Sidecar swaps it for a
local one without touching the engine.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

# Journal kind for the per-turn outcome fact (finish_reason). The run/tool/
# interaction facts keep their SSE event type as their kind; single-agent process
# steps are prefixed so the two lanes are distinguishable in the table.
KIND_TURN_END = "turn_end"
_PROCESS_PREFIX = "process_"


def entries_from_runs(runs: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Flatten an in-memory ``runs`` replay payload into ordered journal entries.

    ``runs`` is the sink-built ``{events, finish_reason, process?}`` payload (see
    ``runtime/pipeline._build_runs_payload``). Each entry is ``{kind, payload, ts}``
    in emission order: the team-graph ``events`` first (each keeping its SSE event
    type as ``kind`` + original ``timestamp`` as ``ts``), then any single-agent
    ``process`` steps (kind-prefixed), then a closing ``turn_end`` carrying the
    finish reason. Returns ``[]`` for an empty / absent payload.
    """
    if not runs:
        return []
    entries: list[dict[str, Any]] = []
    for ev in runs.get("events") or []:
        entries.append(
            {
                "kind": ev.get("type") or "",
                "payload": ev.get("payload") or {},
                "ts": ev.get("timestamp"),
            }
        )
    for step in runs.get("process") or []:
        entries.append(
            {
                "kind": f"{_PROCESS_PREFIX}{step.get('kind') or 'step'}",
                "payload": step,
                "ts": None,
            }
        )
    finish_reason = runs.get("finish_reason")
    if finish_reason is not None:
        entries.append(
            {"kind": KIND_TURN_END, "payload": {"finish_reason": finish_reason}, "ts": None}
        )
    return entries


def runs_from_entries(entries: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Project ordered journal entries back into a ``runs`` replay payload.

    Exact inverse of :func:`entries_from_runs`: team-graph events rebuild the
    ``{type, payload, timestamp}`` shape the client folds, process steps restore
    verbatim from their payload, and the ``turn_end`` fact supplies ``finish_reason``.
    Returns ``None`` when there is nothing replayable (no entries), matching the
    old「``messages.runs`` is NULL」contract so the client renders a plain bubble.
    """
    if not entries:
        return None
    events: list[dict[str, Any]] = []
    process: list[dict[str, Any]] = []
    finish_reason: str | None = None
    for entry in entries:
        kind = entry.get("kind") or ""
        payload = entry.get("payload") or {}
        if kind == KIND_TURN_END:
            finish_reason = payload.get("finish_reason")
        elif kind.startswith(_PROCESS_PREFIX):
            process.append(payload)
        else:
            events.append(
                {"type": kind, "payload": payload, "timestamp": entry.get("ts")}
            )
    runs: dict[str, Any] = {"events": events, "finish_reason": finish_reason}
    if process:
        runs["process"] = process
    return runs


async def persist_turn_journal(
    session: AsyncSession,
    *,
    message_id: str | None,
    conversation_id: str,
    trace_id: str | None,
    runs: dict[str, Any] | None,
) -> None:
    """Record a turn's replay payload to the journal (唯一事实源), best-effort.

    Called from the message-persistence tail right after the assistant row is
    written, on the SAME session, keyed by the assistant ``message_id``. Flattens
    ``runs`` to entries and replaces the turn's rows wholesale (so a resume reusing
    the id re-persists cleanly). A failure must NEVER break the turn (文档铁律, same
    posture as the cost ledger): it rolls back only this write and logs — the reply
    is already committed and the worst case is a turn that won't replay its graph.
    """
    entries = entries_from_runs(runs)
    if not message_id or not entries:
        return
    from agentcore.db.repositories import TurnJournalRepository

    try:
        await TurnJournalRepository(session).record(
            turn_id=message_id,
            conversation_id=conversation_id,
            trace_id=trace_id,
            entries=entries,
        )
    except Exception as e:  # noqa: BLE001 — journal persistence must never break the turn
        await session.rollback()
        logger.warning(
            "journal.persist_failed",
            message_id=message_id,
            error=str(e),
        )
