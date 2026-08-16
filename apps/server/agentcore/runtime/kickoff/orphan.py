"""Orphan prior pending ``team_preview`` before a new kickoff persist.

一会话至多一张可点开工卡：发新卡前把旧 pending 落 ``orphaned(superseded)`` + SSE。
Journal 扫不够——同回合 gather 双发可能都未落盘，须进程内登记已 persist 的 pending。
不 orphan ``ask_user``。
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import EventSink, interaction_orphaned

logger = get_logger(__name__)

_RECENT_TURN_SCAN_LIMIT = 40

# conversation_id → checkpoint_id → live pending (persist 已成功、journal 可能仍空)
_live_pending: dict[str, dict[str, _LiveTeamPreview]] = {}
_persist_locks: dict[str, asyncio.Lock] = {}


@dataclass(frozen=True, slots=True)
class _LiveTeamPreview:
    conversation_id: str
    checkpoint_id: str
    turn_id: str


def persist_lock_for(conversation_id: str) -> asyncio.Lock:
    """Same-conversation persist is serial so gather dual-send can see each other."""
    cid = (conversation_id or "").strip()
    return _persist_locks.setdefault(cid, asyncio.Lock())


def remember_live_team_preview(
    conversation_id: str, checkpoint_id: str, turn_id: str
) -> None:
    cid = (conversation_id or "").strip()
    iid = (checkpoint_id or "").strip()
    tid = (turn_id or "").strip()
    if not cid or not iid:
        return
    _live_pending.setdefault(cid, {})[iid] = _LiveTeamPreview(
        conversation_id=cid, checkpoint_id=iid, turn_id=tid
    )


def forget_live_team_preview(conversation_id: str, checkpoint_id: str) -> None:
    cid = (conversation_id or "").strip()
    iid = (checkpoint_id or "").strip()
    bucket = _live_pending.get(cid)
    if not bucket:
        return
    bucket.pop(iid, None)
    if not bucket:
        _live_pending.pop(cid, None)


def reset_team_preview_orphan_state() -> None:
    """Test helper: drop in-process pending + persist locks."""
    _live_pending.clear()
    _persist_locks.clear()


def list_live_pending_team_previews(
    conversation_id: str,
) -> list[tuple[str, str, dict[str, Any]]]:
    """In-process pending → ``[(host_turn_id, checkpoint_id, payload), ...]``."""
    cid = (conversation_id or "").strip()
    out: list[tuple[str, str, dict[str, Any]]] = []
    for live in _live_pending.get(cid, {}).values():
        out.append((live.turn_id, live.checkpoint_id, {}))
    return out


async def list_journal_pending_team_previews(
    conversation_id: str,
) -> list[tuple[str, str, dict[str, Any]]]:
    """Recent journals → ``[(host_turn_id, checkpoint_id, payload), ...]`` still pending."""
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories import TurnJournalRepository
    from agentcore.runtime.journal.pending_interactions import fold_interactions

    found: list[tuple[str, str, dict[str, Any]]] = []
    async with async_session_factory() as db:
        turn_ids = await TurnJournalRepository(db).list_recent_turn_ids(
            conversation_id, limit=_RECENT_TURN_SCAN_LIMIT
        )
        for turn_id in turn_ids:
            entries = await TurnJournalRepository(db).load(turn_id)
            for rec in fold_interactions(entries):
                if rec.kind == "team_preview" and rec.status == "pending":
                    found.append((turn_id, rec.id, dict(rec.payload)))
    return found


async def list_pending_team_previews(
    conversation_id: str,
) -> list[tuple[str, str, dict[str, Any]]]:
    """Journal ∪ in-process pending team_preview (deduped by checkpoint_id)."""
    by_id: dict[str, tuple[str, str, dict[str, Any]]] = {}
    try:
        for item in await list_journal_pending_team_previews(conversation_id):
            by_id[item[1]] = item
    except Exception as exc:  # noqa: BLE001 — journal 扫失败仍用进程内
        logger.warning(
            "team_preview.list_pending_failed",
            conversation_id=conversation_id,
            error=str(exc),
        )
    for item in list_live_pending_team_previews(conversation_id):
        by_id.setdefault(item[1], item)
    return list(by_id.values())


async def orphan_conversation_team_previews(
    conversation_id: str,
    *,
    sink: EventSink | None = None,
    reason: str | None = None,
    exclude_ids: set[str] | None = None,
) -> list[str]:
    """Orphan pending team_preview (journal fact + optional live SSE).

    ``exclude_ids`` skips the card about to persist (new checkpoint_id).
    """
    from agentcore.runtime.interaction_orphan import emit_orphan_fact

    skip = exclude_ids or set()
    pending = await list_pending_team_previews(conversation_id)
    orphaned: list[str] = []
    for host_turn_id, card_id, _payload in pending:
        if card_id in skip:
            continue
        await emit_orphan_fact(
            interaction_id=card_id,
            kind="team_preview",
            turn_id=host_turn_id or None,
            conversation_id=conversation_id,
            prefer_direct=True,
            reason=reason,
        )
        if sink is not None:
            with contextlib.suppress(Exception):
                sink.emit(
                    interaction_orphaned(
                        interaction_id=card_id, kind="team_preview", reason=reason
                    )
                )
        forget_live_team_preview(conversation_id, card_id)
        orphaned.append(card_id)
    if orphaned:
        logger.info(
            "team_preview.orphaned",
            conversation_id=conversation_id,
            count=len(orphaned),
            ids=orphaned,
            reason=reason or "superseded",
        )
    return orphaned
