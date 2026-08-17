"""Settle a non-blocking ``question_posted``: journal fact + live signal (no new turn)."""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from typing import Any, Literal

from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import TurnJournalRepository
from agentcore.runtime.events import EventSink, publish_conversation_signal, question_resolved
from agentcore.runtime.journal.pending_interactions import InteractionRecord, fold_interactions
from agentcore.runtime.settlement import already_settled_in_writer, prewrite_settlement_direct

logger = get_logger(__name__)

SettleQuestionOutcome = Literal["settled", "already_processed", "not_found"]

# Visible copy when the user answered with files and no caption (answered 须非空).
ATTACHMENT_ANSWER_PLACEHOLDER = "（附件）"
_INJECT_SETTLE_STATUSES = frozenset({"injected", "addressed"})
_ABORT_FINISH_REASONS = frozenset({"cancelled", "interrupted"})


def is_abort_finish_reason(finish: object) -> bool:
    """True for user-stop / crash-salvage finishes that must not close a hanging ask."""
    raw = getattr(finish, "value", finish)
    return isinstance(raw, str) and raw.strip().lower() in _ABORT_FINISH_REASONS


def ask_reply_answer_text(*, content: str, has_attachments: bool = False) -> str | None:
    """Body to journal as ``answered``, or None when this send is not an answer."""
    body = str(content or "").strip()
    if body:
        return body
    if has_attachments:
        return ATTACHMENT_ANSWER_PLACEHOLDER
    return None


def _event_type_name(event: object) -> str:
    t = getattr(event, "type", None)
    if t is None and isinstance(event, Mapping):
        t = event.get("type") or event.get("kind")
    return str(getattr(t, "value", t) or "")


def _event_payload(event: object) -> Mapping[str, Any]:
    payload = getattr(event, "payload", None)
    if payload is None and isinstance(event, Mapping):
        payload = event.get("payload")
    return payload if isinstance(payload, Mapping) else {}


def collect_injected_ask_replies(
    events: Iterable[object] | None,
) -> list[tuple[str, str]]:
    """``(ask_id, answer)`` from injected/addressed interjections (last status wins)."""
    from agentcore.conversation.ask_reply import normalize_ask_id

    latest: dict[str, Mapping[str, Any]] = {}
    anonymous: list[Mapping[str, Any]] = []
    for event in events or ():
        if _event_type_name(event) != "user_interjection":
            continue
        payload = _event_payload(event)
        iid = str(payload.get("interjection_id") or "").strip()
        if iid:
            latest[iid] = payload
        else:
            anonymous.append(payload)

    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for payload in (*latest.values(), *anonymous):
        if str(payload.get("status") or "") not in _INJECT_SETTLE_STATUSES:
            continue
        aid = normalize_ask_id(payload.get("ask_id"))
        if not aid or aid in seen:
            continue
        att = payload.get("attachments")
        has_att = isinstance(att, list) and bool(att)
        text = ask_reply_answer_text(
            content=str(payload.get("content") or ""),
            has_attachments=has_att,
        )
        if not text:
            continue
        seen.add(aid)
        out.append((aid, text))
    return out


def validate_question_settlement(*, status: str, answer: str = "", note: str = "") -> None:
    """Raise ``ValueError`` when the visible settlement is missing required copy."""
    if status not in ("answered", "discarded"):
        raise ValueError("status 须为 answered 或 discarded")
    if status == "answered" and not str(answer or "").strip():
        raise ValueError("answered 须有非空 answer")
    if status == "discarded" and not str(note or "").strip():
        raise ValueError("discarded 须有非空 note")


async def load_question_posted(
    conversation_id: str, ask_id: str
) -> tuple[str, InteractionRecord] | None:
    """Find ``question_posted`` by ``ask_id`` → ``(turn_id, record)`` or None.

    Looks up the host turn that journaled this ask (not a recent-N window): a
    7-day-old pending card must still be settleable.
    """
    async with async_session_factory() as db:
        repo = TurnJournalRepository(db)
        turn_id = await repo.find_turn_id_for_question_posted(
            conversation_id=conversation_id, ask_id=ask_id
        )
        if not turn_id:
            return None
        entries = await repo.load(turn_id)
        for rec in fold_interactions(entries):
            if rec.kind == "question_posted" and rec.id == ask_id:
                return turn_id, rec
    return None


async def settle_question_posted(
    *,
    conversation_id: str,
    ask_id: str,
    status: str,
    answer: str = "",
    note: str = "",
    sink: EventSink | None = None,
) -> SettleQuestionOutcome:
    """Pending → durable ``question_resolved`` + hub signal; already settled → already_processed.

    ``sink`` is the EventSink currently ingesting the user's answer (new-turn POST /
    queue drain, or live steer/coord inject). The sender's connection is following
    that sink; conversation-level follow yields, so the frame must land there.
    Hub fan-out then skips that sink via ``already_on_sink``.
    """
    validate_question_settlement(status=status, answer=answer, note=note)
    found = await load_question_posted(conversation_id, ask_id)
    if found is None:
        return "not_found"
    turn_id, rec = found
    if rec.status != "pending":
        return "already_processed"

    event = question_resolved(
        ask_id=ask_id,
        status=status,
        answer=str(answer or "").strip(),
        note=str(note or "").strip(),
    )
    if already_settled_in_writer(event):
        return "already_processed"
    await prewrite_settlement_direct(
        turn_id=turn_id,
        conversation_id=conversation_id,
        trace_id=get_log_value("trace_id") or None,
        event=event,
    )
    if sink is not None:
        sink.emit(event)
    publish_conversation_signal(conversation_id, event, already_on_sink=sink)
    from agentcore.attention import signal_question_posted_resolved

    await signal_question_posted_resolved(
        conversation_id=conversation_id,
        turn_id=turn_id,
        interaction_id=ask_id,
        payload=rec.payload,
    )
    logger.info(
        "question_posted.settled",
        conversation_id=conversation_id,
        ask_id=ask_id,
        status=status,
        turn_id=turn_id,
    )
    return "settled"


async def note_ask_reply_ingested(
    *,
    conversation_id: str,
    ask_id: str | None,
    answer: str,
    sink: EventSink | None = None,
    has_attachments: bool = False,
) -> None:
    """Close a hanging question once this send's submission facts stuck.

    No ``ask_id``, and neither a non-empty body nor attachments → no-op.
    ``not_found`` / ``already_processed`` are swallowed. Any other failure is
    logged and must not fail the turn.
    """
    from agentcore.conversation.ask_reply import normalize_ask_id

    aid = normalize_ask_id(ask_id)
    body = ask_reply_answer_text(content=answer, has_attachments=has_attachments)
    if not aid or not body:
        return
    try:
        await settle_question_posted(
            conversation_id=conversation_id,
            ask_id=aid,
            status="answered",
            answer=body,
            sink=sink,
        )
    except Exception as exc:  # noqa: BLE001 — ingest must not fail the turn
        logger.warning(
            "question_posted.ingest_settle_failed",
            conversation_id=conversation_id,
            ask_id=aid,
            error=str(exc),
        )


async def note_ask_replies_for_committed_send(
    *,
    conversation_id: str,
    sink: EventSink | None = None,
    ask_id: str | None = None,
    answer: str = "",
    has_attachments: bool = False,
    journal: Sequence[Any] | None = None,
) -> None:
    """Settle this send's ask_id plus injected ask_id replies on the committed sink.

    Call only after abort / unsubmitted failure / zero-output rollback have been
    excluded. Enqueue / ``received`` must not call this.
    """
    from agentcore.conversation.ask_reply import normalize_ask_id

    seen: set[str] = set()

    async def _one(raw_id: str | None, content: str, attached: bool) -> None:
        nid = normalize_ask_id(raw_id)
        if not nid or nid in seen:
            return
        text = ask_reply_answer_text(content=content, has_attachments=attached)
        if not text:
            return
        seen.add(nid)
        await note_ask_reply_ingested(
            conversation_id=conversation_id,
            ask_id=nid,
            answer=text,
            sink=sink,
        )

    await _one(ask_id, answer, has_attachments)
    events: list[Any] = []
    if sink is not None:
        events.extend(sink.history_snapshot())
        host_journal = sink.execution_journal()
        if host_journal:
            events.extend(host_journal)
    if journal:
        events.extend(journal)
    for injected_id, text in collect_injected_ask_replies(events):
        await _one(injected_id, text, False)
