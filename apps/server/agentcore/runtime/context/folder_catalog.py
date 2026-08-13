"""Derived CEO ``<文件夹清单>`` — Folder roster + 画像.md first line.

Read-time projection for「跨文件夹找文件夹」: assembled fresh each prepare turn from
the user's live Folder list (recent-activity order, hard count cap) plus each
folder's ``画像.md`` first substantive line. Not a memory file, not consolidated,
never expires — rename / move / profile edits show up on the next turn.

Rows carry the **full path** (``设计/图标``), not just the last segment: folders
nest, the same last segment can live at two levels, and a name-only listing would
send every ``resolve_folder`` straight into an ambiguity round-trip.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import FolderRepository
from agentcore.memory.store import CORE_MEMORY_FILE, MemoryStore
from agentcore.memory.user_memory import topic_summary_line
from agentcore.workspace.cloud_tree import normalize_rel_path

logger = get_logger(__name__)


@dataclass(frozen=True)
class FolderCatalogEntry:
    """One injected folder row: stable id + where it sits + optional one-liner."""

    folder_id: str
    name: str
    summary: str = ""
    rel_path: str = ""

    @property
    def label(self) -> str:
        """What the model should hand back to ``resolve_folder``."""
        return self.rel_path or self.name


def build_folder_catalog_entries(
    folders: Sequence[tuple[str, str] | tuple[str, str, str]],
    profiles: Mapping[str, str],
    *,
    limit: int,
) -> list[FolderCatalogEntry]:
    """Pure assemble: already-sorted folders × profile bodies → capped entries.

    ``folders`` is ``(folder_id, name)`` or ``(folder_id, name, rel_path)`` in
    recent-activity order (caller sorts). ``profiles`` maps ``folder_id → 画像.md``
    markdown (missing → name-only row).
    """
    if limit <= 0 or not folders:
        return []
    out: list[FolderCatalogEntry] = []
    for row in folders[:limit]:
        folder_id, name = row[0], row[1]
        rel_path = normalize_rel_path(row[2]) if len(row) > 2 else ""
        body = profiles.get(folder_id) or ""
        summary = topic_summary_line(body) if body else ""
        out.append(
            FolderCatalogEntry(
                folder_id=folder_id, name=name, summary=summary, rel_path=rel_path
            )
        )
    return out


def render_folder_catalog(entries: Sequence[FolderCatalogEntry]) -> str:
    """CEO ``<文件夹清单>`` block; ``""`` when empty so the assembler drops the section."""
    if not entries:
        return ""
    lines = [
        "<文件夹清单>",
        "用户云盘里的文件夹（按最近活跃截断；仅路径＋一句话定位，非全文记忆）。"
        "路径带 `/` 的是嵌套层级。跨文件夹点名用 `list_folders` / `resolve_folder`"
        "（传下面这一整条路径，别只传末段）；摸底或写盘派工填 `target_folder_id`：",
    ]
    for entry in entries:
        if entry.summary:
            lines.append(f"- {entry.label}：{entry.summary}")
        else:
            lines.append(f"- {entry.label}")
    lines.append("</文件夹清单>")
    return "\n".join(lines)


async def load_folder_catalog(
    store: MemoryStore,
    user_id: str,
    *,
    limit: int | None = None,
) -> list[FolderCatalogEntry]:
    """Load recent Folders + 画像 first lines for CEO injection.

    Soft-degrades to ``[]`` on any failure (must never break prepare). Profile
    bodies ride ``MemoryStore`` so local DB and account-ticket warm paths stay
    consistent with other prepare reads; uncached scopes yield name-only rows.
    """
    cap = settings.folder_catalog_max_entries if limit is None else limit
    if cap <= 0:
        return []
    try:
        async with async_session_factory() as session:
            folders = await FolderRepository(session).list_by_user_recently_active(
                user_id, limit=cap
            )
    except Exception as e:  # noqa: BLE001 - catalog must never break a turn
        logger.warning(
            "folder_catalog.list_failed",
            user_id=user_id,
            error=str(e),
        )
        return []
    if not folders:
        return []

    profiles: dict[str, str] = {}
    for folder in folders:
        try:
            body = await store.load(user_id, CORE_MEMORY_FILE, scope=folder.id)
        except Exception as e:  # noqa: BLE001 - name-only row is fine
            logger.warning(
                "folder_catalog.profile_load_failed",
                user_id=user_id,
                folder_id=folder.id,
                error=str(e),
            )
            body = ""
        if body:
            profiles[folder.id] = body

    return build_folder_catalog_entries(
        [(f.id, f.name, f.rel_path or "") for f in folders],
        profiles,
        limit=cap,
    )
