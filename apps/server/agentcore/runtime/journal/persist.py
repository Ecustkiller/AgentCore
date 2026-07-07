"""Best-effort journal persistence to Postgres."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.config import settings
from agentcore.core.logging import get_logger

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)


from agentcore.runtime.journal.entries import KIND_TURN_END

_PROCESS_PREFIX = "process_"


def _tail_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Process steps + ``turn_end`` — appended at turn close, not emit-on-write."""
    return [
        e
        for e in entries
        if e.get("kind") == KIND_TURN_END
        or str(e.get("kind") or "").startswith(_PROCESS_PREFIX)
    ]


async def persist_turn_journal(
    session: AsyncSession,
    *,
    message_id: str | None,
    conversation_id: str,
    trace_id: str | None,
    entries: list[dict[str, Any]] | None,
) -> None:
    """Record a turn's replay payload to the journal (唯一事实源), best-effort.

    Called from the message-persistence tail right after the assistant row is
    written, on the SAME session, keyed by the assistant ``message_id``. When the
    turn already has append-on-emit rows, only the tail (process / ``turn_end``)
    is appended; otherwise replaces wholesale (salvage / legacy paths). A failure
    must NEVER break the turn (文档铁律, same posture as the cost ledger): it rolls
    back only this write and logs — the reply is already committed and the worst
    case is a turn that won't replay its graph.

    ``entries`` is the §8.3 fact-log stream (execution facts interleaved with
    forwarded display facts, plus process / ``turn_end`` tail). Callers that only
    hold a display ``runs`` payload must flatten via
    :func:`entries.journal_entries_from_display_runs` before calling.
    """
    if not message_id or not entries:
        return
    from agentcore.db.repositories import TurnJournalRepository

    repo = TurnJournalRepository(session)
    try:
        existing = await repo.load(message_id)
        if not existing:
            await repo.record(
                turn_id=message_id,
                conversation_id=conversation_id,
                trace_id=trace_id,
                entries=entries,
            )
        elif len(entries) > len(existing):
            delta = entries[len(existing) :]
            for seq, entry in enumerate(delta, start=len(existing)):
                await repo.append(
                    turn_id=message_id,
                    seq=seq,
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                    entry=entry,
                )
        else:
            delta = _tail_entries(entries)
            if not delta:
                return
            if any(e.get("kind") == KIND_TURN_END for e in existing):
                delta = [e for e in delta if e.get("kind") != KIND_TURN_END]
            if not delta:
                return
            for seq, entry in enumerate(delta, start=len(existing)):
                await repo.append(
                    turn_id=message_id,
                    seq=seq,
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                    entry=entry,
                )
    except Exception as e:  # noqa: BLE001 — journal persistence must never break the turn
        await session.rollback()
        logger.warning(
            "journal.persist_failed",
            message_id=message_id,
            error=str(e),
        )
        return

    # D2 观测：把同一份耐久 entries 投影成执行 span 树并导出（off the user path、
    # best-effort）。这里是所有回合路径（首轮 / 重答 / handoff / resume / salvage）写
    # 耐久 journal 的唯一汇点，故 span 树天然覆盖全路径。导出自身吞异常、绝不影响回合。
    if settings.observability_span_export_enabled:
        from agentcore.runtime.spans import export_turn_spans

        export_turn_spans(
            entries,
            trace_id=trace_id,
            conversation_id=conversation_id,
            message_id=message_id,
        )
