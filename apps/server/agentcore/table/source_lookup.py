"""Find the live table for a workspace csv path (REST 打开即表)."""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import is_uuid_id
from agentcore.db.models.conversations import Conversation
from agentcore.db.models.tables import Table
from agentcore.db.repositories._desk_visibility import conversation_visible_clause
from agentcore.db.repositories.tables import TableRepository
from agentcore.table.csv_import import is_csv_relpath
from agentcore.table.workspace_key import table_workspace_key
from agentcore.workspace.sparse_listing import is_attachment_path


def normalize_csv_source_path(path: str) -> str | None:
    p = path.replace("\\", "/").strip().lstrip("./")
    if not p or not is_csv_relpath(p) or is_attachment_path(p):
        return None
    return p


def candidate_workspace_keys(
    *,
    folder_id: str | None,
    conversation_id: str | None,
    conversation_folder_id: str | None = None,
    conversation_auto_desk_id: str | None = None,
    desk_conversation_ids: tuple[str, ...] = (),
) -> list[str]:
    """Keys ingest may have used: folder desk, auto-desk, or 裸聊 ``conv:``."""
    keys: list[str] = []
    seen: set[str] = set()

    def add(*, fid: str | None, cid: str | None) -> None:
        fid_s = (fid or "").strip() or None
        cid_s = (cid or "").strip() or None
        if not fid_s and not cid_s:
            return
        key = table_workspace_key(folder_id=fid_s, conversation_id=cid_s or "")
        if key not in seen:
            seen.add(key)
            keys.append(key)

    add(fid=folder_id, cid=None)
    add(fid=conversation_folder_id, cid=None)
    add(fid=conversation_auto_desk_id, cid=None)
    add(fid=None, cid=conversation_id)
    for extra in desk_conversation_ids:
        add(fid=None, cid=extra)
    return keys


async def lookup_table_by_csv_source(
    session: AsyncSession,
    *,
    user_id: str,
    path: str,
    folder_id: str | None,
    conversation_id: str | None,
) -> Table | None:
    rel = normalize_csv_source_path(path)
    if rel is None:
        return None
    fid = (folder_id or "").strip() or None
    cid = (conversation_id or "").strip() or None
    conv_folder: str | None = None
    conv_auto: str | None = None
    if cid and is_uuid_id(cid):
        conv = await session.execute(
            select(Conversation).where(
                Conversation.id == cid,
                Conversation.deleted_at.is_(None),
                conversation_visible_clause(user_id),
            )
        )
        row = conv.scalar_one_or_none()
        if row is not None:
            conv_folder = (row.folder_id or "").strip() or None
            conv_auto = (row.auto_desk_folder_id or "").strip() or None
    desk_ids: tuple[str, ...] = ()
    if fid and is_uuid_id(fid):
        desk_q = await session.execute(
            select(Conversation.id).where(
                Conversation.deleted_at.is_(None),
                conversation_visible_clause(user_id),
                or_(
                    Conversation.folder_id == fid,
                    Conversation.auto_desk_folder_id == fid,
                ),
            )
        )
        desk_ids = tuple(desk_q.scalars().all())
    keys = candidate_workspace_keys(
        folder_id=fid,
        conversation_id=cid,
        conversation_folder_id=conv_folder,
        conversation_auto_desk_id=conv_auto,
        desk_conversation_ids=desk_ids,
    )
    if not keys:
        return None
    repo = TableRepository(session)
    for key in keys:
        table = await repo.get_by_source(user_id=user_id, workspace_key=key, path=rel)
        if table is not None:
            return table
    return None
