"""Derived CEO ``<项目清单>`` — Folder roster + project 画像.md first line.

Read-time projection for「跨项目找项目」: assembled fresh each prepare turn from
the user's live Folder list (recent-activity order, hard count cap) plus each
project's ``画像.md`` first substantive line. Not a memory file, not consolidated,
never expires — rename / profile edits show up on the next turn.
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

logger = get_logger(__name__)


@dataclass(frozen=True)
class ProjectCatalogEntry:
    """One injected project row: stable id + display name + optional one-liner."""

    folder_id: str
    name: str
    summary: str = ""


def build_project_catalog_entries(
    folders: Sequence[tuple[str, str]],
    profiles: Mapping[str, str],
    *,
    limit: int,
) -> list[ProjectCatalogEntry]:
    """Pure assemble: already-sorted folders × profile bodies → capped entries.

    ``folders`` is ``(folder_id, name)`` in recent-activity order (caller sorts).
    ``profiles`` maps ``folder_id → 画像.md`` markdown (missing → name-only row).
    """
    if limit <= 0 or not folders:
        return []
    out: list[ProjectCatalogEntry] = []
    for folder_id, name in folders[:limit]:
        body = profiles.get(folder_id) or ""
        summary = topic_summary_line(body) if body else ""
        out.append(
            ProjectCatalogEntry(folder_id=folder_id, name=name, summary=summary)
        )
    return out


def render_project_catalog(entries: Sequence[ProjectCatalogEntry]) -> str:
    """CEO ``<项目清单>`` block; ``""`` when empty so the assembler drops the section."""
    if not entries:
        return ""
    lines = [
        "<项目清单>",
        "用户已登记的项目（按最近活跃截断；仅名称＋一句话定位，非全文记忆）。"
        "跨项目点名用 `list_projects` / `resolve_project`；摸底或写盘派工填"
        " `target_folder_id`：",
    ]
    for entry in entries:
        if entry.summary:
            lines.append(f"- {entry.name}：{entry.summary}")
        else:
            lines.append(f"- {entry.name}")
    lines.append("</项目清单>")
    return "\n".join(lines)


async def load_project_catalog(
    store: MemoryStore,
    user_id: str,
    *,
    limit: int | None = None,
) -> list[ProjectCatalogEntry]:
    """Load recent Folders + project 画像 first lines for CEO injection.

    Soft-degrades to ``[]`` on any failure (must never break prepare). Profile
    bodies ride ``MemoryStore`` so local DB and account-ticket warm paths stay
    consistent with other prepare reads; uncached scopes yield name-only rows.
    """
    cap = settings.project_catalog_max_entries if limit is None else limit
    if cap <= 0:
        return []
    try:
        async with async_session_factory() as session:
            folders = await FolderRepository(session).list_by_user_recently_active(
                user_id, limit=cap
            )
    except Exception as e:  # noqa: BLE001 - catalog must never break a turn
        logger.warning(
            "project_catalog.list_failed",
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
                "project_catalog.profile_load_failed",
                user_id=user_id,
                folder_id=folder.id,
                error=str(e),
            )
            body = ""
        if body:
            profiles[folder.id] = body

    return build_project_catalog_entries(
        [(f.id, f.name) for f in folders],
        profiles,
        limit=cap,
    )
