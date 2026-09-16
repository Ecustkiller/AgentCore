"""Resolve the live table for a main-chat turn from @ csv attachments."""

from __future__ import annotations

from typing import Any

from agentcore.core.paths import is_absolute_os_path
from agentcore.table.csv_import import is_csv_relpath
from agentcore.table.workspace_key import table_workspace_key
from agentcore.workspace.sparse_listing import is_attachment_path

_PATH_KEYS = ("workspace_path", "path", "parsed_workspace_path")


def _relpath(raw: str) -> str | None:
    if is_absolute_os_path(raw):
        return None
    p = raw.replace("\\", "/").strip().lstrip("./")
    if not p or p == ".":
        return None
    if is_absolute_os_path(p):
        return None
    return p


def csv_mention_paths(attachments: list[dict[str, Any]] | None) -> list[str]:
    """Workspace csv paths the user @ cited this turn, attachment order, no attachments/."""
    if not attachments:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for att in attachments:
        if att.get("resident_missing"):
            continue
        for key in _PATH_KEYS:
            raw = att.get(key)
            if not isinstance(raw, str) or not raw.strip():
                continue
            cleaned = _relpath(raw)
            if (
                cleaned is None
                or cleaned in seen
                or not is_csv_relpath(cleaned)
                or is_attachment_path(cleaned)
            ):
                continue
            seen.add(cleaned)
            out.append(cleaned)
    return out


async def lookup_table_id_for_turn(
    *,
    user_id: str,
    conversation_id: str,
    folder_id: str | None,
    attachments: list[dict[str, Any]] | None,
) -> str | None:
    """@ csv seed wins; else leftover dedicated table conversation."""
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories.tables import TableRepository
    from agentcore.table.context import lookup_table_id

    paths = csv_mention_paths(attachments)
    if paths and user_id:
        key = table_workspace_key(folder_id=folder_id, conversation_id=conversation_id)
        async with async_session_factory() as session:
            repo = TableRepository(session)
            for path in paths:
                table = await repo.get_by_source(
                    user_id=user_id, workspace_key=key, path=path
                )
                if table is not None:
                    return table.id
    return await lookup_table_id(conversation_id=conversation_id, user_id=user_id)
