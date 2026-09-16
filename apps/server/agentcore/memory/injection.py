"""Memory topic directory is retired from prompt injection.

AI-maintained topic notes stay on disk. The turn catalog / ``consult`` do not
list or fetch them. Folder-layer labels below are still used by user-rule join.
"""

from __future__ import annotations

from dataclasses import dataclass

from agentcore.core.logging import get_logger
from agentcore.memory.store import MemoryScope, MemoryStore

logger = get_logger(__name__)

# Layer labels inside the shared <设定> block (scope, not author).
_FOLDER_SETTINGS_LABEL = "（以下为「当前文件夹」专属设定，仅在本文件夹内适用）"
_FOLDER_NAV_LABEL = "（以下为「当前文件夹」导航短入口，只指路、不塞长文）"
_ANCESTOR_SETTINGS_LABEL = (
    "（以下为「上层文件夹」的设定，其下所有文件夹一并适用；"
    "与更靠近当前文件夹的设定冲突时，以更近的为准）"
)


@dataclass(frozen=True)
class MemoryTopic:
    """Kept for warm-snapshot typing; topics are not injected."""

    name: str
    summary: str


async def disputed_memory_paths(
    store: MemoryStore, user_id: str, scope: MemoryScope = None
) -> frozenset[str]:
    """Note paths the user marked wrong in one scope (file page / dispute UI)."""
    try:
        return frozenset(
            meta.path for meta in await store.list(user_id, scope=scope) if meta.disputed
        )
    except Exception as e:  # noqa: BLE001 - memory reads never break turn assembly
        logger.warning("memory.disputed_paths_failed", user_id=user_id, error=str(e))
        return frozenset()


async def load_memory_topics(
    store: MemoryStore, user_id: str, *, folder_id: str | None
) -> list[MemoryTopic]:
    """Always empty: AI topic notes are not catalogued into the turn."""
    del store, user_id, folder_id
    return []
