"""Snapshot-import a landed workspace csv into the account-level 多维表格."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from sqlalchemy.exc import IntegrityError

from agentcore.core.logging import get_logger
from agentcore.table.constants import CSV_IMPORT_MAX_BYTES
from agentcore.table.csv_import import (
    CsvSnapshot,
    decode_csv_bytes,
    is_csv_relpath,
    parse_csv_snapshot,
    remap_snapshot_columns,
    title_from_csv_path,
)
from agentcore.table.workspace_key import table_workspace_key
from agentcore.tools.file_products import FileProduct
from agentcore.workspace.sparse_listing import is_attachment_path

if TYPE_CHECKING:
    from agentcore.db.models.tables import Table
    from agentcore.db.repositories.tables import TableRepository
    from agentcore.table.state import TableState
    from agentcore.tools.protocol import ToolContext, ToolResult
    from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_IMPORT_NOTE = (
    "已导入多维表格「{title}」。改格子用 table_ops；再写此 csv 会覆盖整表。"
)


@dataclass(frozen=True)
class CsvIngestNote:
    table_id: str
    note: str


def should_ingest_csv_path(path: str) -> bool:
    p = path.replace("\\", "/").strip().lstrip("./")
    return bool(p) and is_csv_relpath(p) and not is_attachment_path(p)


async def ingest_landed_csv_products(
    result: ToolResult,
    context: ToolContext,
    *,
    registry: ToolRegistry | None = None,
    offer_tools: bool = False,
) -> str:
    """Import each landed csv product. Failures are notes, not write failures."""
    if not result.file_products:
        return ""
    notes: list[str] = []
    ids: list[str] = []
    for product in result.file_products:
        if not isinstance(product, FileProduct):
            continue
        if not should_ingest_csv_path(product.path):
            continue
        note = await ingest_landed_csv(context, product.path)
        if note:
            notes.append(note.note)
            ids.append(note.table_id)
    unique = list(dict.fromkeys(ids))
    if len(unique) == 1:
        context.table_id = unique[0]
        if offer_tools and registry is not None:
            _ensure_table_tools_offered(registry)
    return "\n".join(notes)


async def ingest_landed_csv(context: ToolContext, path: str) -> CsvIngestNote | None:
    """Create or overwrite the table for this workspace path."""
    rel = path.replace("\\", "/").strip().lstrip("./")
    if not should_ingest_csv_path(rel):
        return None
    user_id = (context.user_id or "").strip()
    conversation_id = (context.conversation_id or "").strip()
    if not user_id or not conversation_id:
        return None
    try:
        data = await context.backend.read_bytes(rel, max_bytes=CSV_IMPORT_MAX_BYTES + 1)
    except Exception:
        logger.warning("table.csv_ingest_read_failed", path=rel, exc_info=True)
        return None
    if len(data) > CSV_IMPORT_MAX_BYTES:
        logger.info("table.csv_ingest_skipped", path=rel, reason="too_large")
        return None
    snapshot = parse_csv_snapshot(decode_csv_bytes(data), title=title_from_csv_path(rel))
    if snapshot is None:
        return None
    key = table_workspace_key(
        folder_id=context.ownership_desk_id,
        conversation_id=conversation_id,
    )
    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories.tables import TableRepository

    overwritten = False
    try:
        async with async_session_factory() as session:
            repo = TableRepository(session)
            state, overwritten = await _upsert_snapshot(
                repo, user_id=user_id, key=key, rel=rel, snapshot=snapshot
            )
    except Exception:
        logger.warning("table.csv_ingest_failed", path=rel, exc_info=True)
        return None
    extra = []
    if snapshot.truncated_rows:
        extra.append("行已截到 5000")
    if snapshot.truncated_cols:
        extra.append("列已截到上限")
    text = _IMPORT_NOTE.format(title=state.title)
    if extra:
        text = f"{text}（{'；'.join(extra)}）"
    logger.info(
        "table.csv_ingested",
        table_id=state.id,
        path=rel,
        rows=len(state.rows),
        overwritten=overwritten,
    )
    return CsvIngestNote(table_id=state.id, note=text)


async def _upsert_snapshot(
    repo: TableRepository,
    *,
    user_id: str,
    key: str,
    rel: str,
    snapshot: CsvSnapshot,
) -> tuple[TableState, bool]:
    existing = await repo.get_by_source(user_id=user_id, workspace_key=key, path=rel)
    if existing is not None:
        return await _overwrite(repo, existing, user_id=user_id, snapshot=snapshot), True
    try:
        state = await repo.create_from_csv(
            user_id=user_id,
            title=snapshot.title,
            columns=snapshot.columns,
            rows=snapshot.rows,
            workspace_key=key,
            path=rel,
        )
        return state, False
    except IntegrityError:
        await repo._session.rollback()
        existing = await repo.get_by_source(
            user_id=user_id, workspace_key=key, path=rel
        )
        if existing is None:
            raise
        return await _overwrite(repo, existing, user_id=user_id, snapshot=snapshot), True


async def _overwrite(
    repo: TableRepository,
    existing: Table,
    *,
    user_id: str,
    snapshot: CsvSnapshot,
) -> TableState:
    state = await repo.get_state(existing.id, user_id=user_id)
    if state is None:
        raise RuntimeError("csv overwrite target vanished")
    mapped = remap_snapshot_columns(snapshot, state.columns)
    return await repo.replace_csv_snapshot(
        state,
        title=state.title,
        columns=mapped.columns,
        rows=mapped.rows,
    )


def _ensure_table_tools_offered(registry: ToolRegistry) -> None:
    from agentcore.tools.registration import register_table_ceo_tools

    if registry.get_optional("table_ops") is None:
        register_table_ceo_tools(registry)
    registry.offer("table_ops")
