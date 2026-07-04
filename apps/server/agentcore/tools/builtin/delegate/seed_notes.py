"""CEO seeding for the per-batch team note wall (Phase 2 · seed_notes)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import team_note_posted
from agentcore.runtime.runs.notewall import (
    MAX_NOTE_CHARS,
    NOTE_KIND_HEADS_UP,
    NOTE_KINDS,
    NoteWall,
)

if TYPE_CHECKING:
    from agentcore.runtime.events.sink import EventSink

logger = get_logger(__name__)

CEO_SEED_RUN_ID = "__ceo_seed__"
CEO_SEED_AGENT_ID = "ceo"
CEO_SEED_ROLE = "主 Agent"
MAX_SEED_NOTES = 8
MAX_TEAM_BRIEF_CHARS = 1500


def _clean_brief(text: str) -> str:
    collapsed = "\n".join(line.rstrip() for line in text.splitlines()).strip()
    if len(collapsed) > MAX_TEAM_BRIEF_CHARS:
        collapsed = collapsed[: MAX_TEAM_BRIEF_CHARS - 1].rstrip() + "…"
    return collapsed


def parse_team_brief(raw: Any) -> tuple[str | None, str | None]:
    if raw is None:
        return None, None
    if not isinstance(raw, str):
        return None, "team_brief 必须是字符串。"
    brief = _clean_brief(raw)
    if not brief:
        return None, "team_brief 清理后为空。"
    return brief, None


def parse_seed_notes(raw: Any) -> tuple[list[dict[str, str]], str | None]:
    if raw is None:
        return [], None
    if not isinstance(raw, list):
        return [], "seed_notes 必须是数组。"
    if len(raw) > MAX_SEED_NOTES:
        return [], f"seed_notes 最多 {MAX_SEED_NOTES} 条。"
    out: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            return [], f"seed_notes[{i}] 必须是对象。"
        kind = item.get("kind", NOTE_KIND_HEADS_UP)
        if not isinstance(kind, str):
            return [], f"seed_notes[{i}].kind 必须是字符串。"
        kind = kind if kind in NOTE_KINDS else NOTE_KIND_HEADS_UP
        text = item.get("text", "")
        if not isinstance(text, str) or not text.strip():
            return [], f"seed_notes[{i}].text 必须是非空字符串。"
        collapsed = " ".join(text.split())
        if len(collapsed) > MAX_NOTE_CHARS:
            collapsed = collapsed[: MAX_NOTE_CHARS - 1].rstrip() + "…"
        out.append({"kind": kind, "text": collapsed})
    return out, None


def seed_note_wall(
    wall: NoteWall,
    notes: list[dict[str, str]],
    *,
    sink: EventSink,
    execution_id: str,
) -> int:
    """Pin CEO-authored notes before the first worker wave runs. Returns count seeded."""
    count = 0
    for item in notes:
        note = wall.post(
            run_id=CEO_SEED_RUN_ID,
            agent_id=CEO_SEED_AGENT_ID,
            role=CEO_SEED_ROLE,
            kind=item.get("kind", NOTE_KIND_HEADS_UP),
            text=item["text"],
        )
        if note is None:
            continue
        count += 1
        sink.emit(
            team_note_posted(
                execution_id=execution_id,
                note_id=note.note_id,
                run_id=note.run_id,
                agent_id=note.agent_id,
                role=note.role,
                kind=note.kind,
                text=note.text,
                ts=note.ts,
                source="ceo",
            )
        )
    if count:
        logger.info("delegate.seed_notes", count=count, execution_id=execution_id)
    return count
