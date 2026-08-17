"""CEO volatile-tail: this conversation's still-pending non-blocking questions.

Next-turn LLM history deliberately drops tool I/O, so ``ask_user`` results never
re-enter the window. This block is the sticky replacement: fold the journals that
actually posted a ``question_posted``, keep only ``pending``, and ride the CEO
assembler tail (not the standing core — core is rules, this is this-chat fact).

Must NOT copy the one-shot「scan the prior turn, inject, throw away」shape
(定案 §二·④): without fold settlement that path re-injects every historical
question as still hanging. Cost sits with the other volatile-tail facts
(``<recent_team_graph>`` / ``<prior_delivery_gaps>``): short lines, no count cap.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.journal.pending_interactions import (
    InteractionRecord,
    fold_interactions,
)

logger = get_logger(__name__)

# Same per-line budget as ``<recent_team_graph>`` task briefs — not a question cap.
_MAX_QUESTION_CHARS = 80
_MAX_UNLOCKS_CHARS = 80


def pending_question_records(entries: list[dict[str, Any]] | None) -> list[InteractionRecord]:
    """Fold facts → the ``question_posted`` rows still pending (insertion order)."""
    if not entries:
        return []
    return [
        rec
        for rec in fold_interactions(entries)
        if rec.kind == "question_posted" and rec.status == "pending"
    ]


def collect_pending_questions(
    journals: dict[str, list[dict[str, Any]]],
    host_turn_ids: list[str],
) -> list[tuple[str, InteractionRecord]]:
    """``(turn_id, record)`` for pending questions, in ``host_turn_ids`` order.

    A resolved / discarded / orphaned card on an older turn is omitted — that is
    the §二·④ ratchet: historical posts must not come back as hanging.
    """
    out: list[tuple[str, InteractionRecord]] = []
    for turn_id in host_turn_ids:
        for rec in pending_question_records(journals.get(turn_id) or []):
            out.append((turn_id, rec))
    return out


def _clip(text: str, limit: int) -> str:
    value = " ".join((text or "").split())
    if not value:
        return "—"
    if len(value) > limit:
        return value[:limit] + "…"
    return value


def _default_of(payload: dict[str, Any]) -> str:
    questions = payload.get("questions") or []
    if isinstance(questions, list):
        for q in questions:
            if not isinstance(q, dict):
                continue
            default = str(q.get("default") or "").strip()
            if default:
                return default
    assumptions = payload.get("assumptions") or []
    if isinstance(assumptions, list):
        for row in assumptions:
            if not isinstance(row, dict):
                continue
            value = str(row.get("value") or row.get("label") or "").strip()
            if value:
                return value
    return "—"


def render_pending_questions(items: list[tuple[str, InteractionRecord]]) -> str:
    """``<pending_questions>`` block, or ``\"\"`` when nothing is still pending."""
    if not items:
        return ""
    lines = [
        "<pending_questions>",
        "本会话仍有未答的非阻塞提问：",
    ]
    for _turn_id, rec in items:
        payload = rec.payload
        question = _clip(str(payload.get("question") or ""), _MAX_QUESTION_CHARS)
        unlocks = _clip(str(payload.get("unlocks") or ""), _MAX_UNLOCKS_CHARS)
        default = _clip(_default_of(payload), _MAX_QUESTION_CHARS)
        lines.append(
            f"- ask_id={rec.id}; question={question}; unlocks={unlocks}; default={default}"
        )
    lines.append("</pending_questions>")
    return "\n".join(lines)


async def build_pending_questions_hint(
    *,
    conversation_id: str,
    exclude_message_id: str | None = None,
) -> str:
    """Volatile-tail block for this conversation's still-pending questions.

    ``exclude_message_id`` drops the in-flight assistant turn (same as recent-graph).
    Empty string when none are pending or the journal cannot be read — the assembler
    then drops the section.
    """
    cid = (conversation_id or "").strip()
    if not cid:
        return ""
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import TurnJournalRepository

        async with async_session_factory() as session:
            repo = TurnJournalRepository(session)
            hosts = await repo.list_question_posted_hosts(
                conversation_id=cid,
                exclude_turn_id=exclude_message_id,
            )
            if not hosts:
                return ""
            turn_ids = [turn_id for _cid, turn_id in hosts]
            journals = await repo.load_map(turn_ids)
    except Exception as exc:  # noqa: BLE001 — missing block is safer than failing assemble
        logger.warning(
            "pending_questions.load_failed",
            conversation_id=cid,
            error=str(exc),
        )
        return ""
    items = collect_pending_questions(journals, turn_ids)
    return render_pending_questions(items)
