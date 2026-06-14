"""Long-term memory storage.

Long-term memory is the markdown body of the user's `ai_maintained` rule file
(see docs/03-AI核心/Agent记忆与知识系统.md §1.4 / §五). The cloud file-tree / Document
subsystem that will ultimately host that file does not exist yet, so the MVP
backs it with one markdown file per user under the server data dir. The content
is exactly the file body; when the file tree lands, migrate it into a
`rule` + `ai_maintained=true` Document — storage is hidden behind `MemoryStore`
so swapping the backend is a one-liner.
"""

from pathlib import Path
from typing import Protocol

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


class MemoryStore(Protocol):
    """Loads/saves a user's long-term memory markdown."""

    async def load(self, user_id: str) -> str:
        """Return the user's memory markdown, or "" if there is none yet."""
        ...

    async def save(self, user_id: str, markdown: str) -> None:
        """Persist the user's memory markdown."""
        ...


class FileMemoryStore:
    """MVP MemoryStore: one markdown file per user under a base directory.

    File I/O is synchronous but the files are tiny (a few KB), so it runs inline.
    Failures are logged and degrade to empty / no-op so memory never breaks a turn.
    """

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)

    def _path(self, user_id: str) -> Path:
        # user_id is a server-issued UUID; still neutralize any path separators.
        safe = user_id.replace("/", "_").replace("\\", "_").replace("..", "_")
        if not safe:
            safe = "_"
        return self._base / f"{safe}.md"

    async def load(self, user_id: str) -> str:
        path = self._path(user_id)
        try:
            return path.read_text(encoding="utf-8") if path.exists() else ""
        except OSError as e:
            logger.warning("memory_load_failed", user_id=user_id, error=str(e))
            return ""

    async def save(self, user_id: str, markdown: str) -> None:
        path = self._path(user_id)
        try:
            self._base.mkdir(parents=True, exist_ok=True)
            path.write_text(markdown, encoding="utf-8")
        except OSError as e:
            logger.warning("memory_save_failed", user_id=user_id, error=str(e))


def default_memory_store() -> FileMemoryStore:
    """Build the MVP file-backed store under `<settings.data_dir>/memory`."""
    from agentcore.config import settings

    return FileMemoryStore(Path(settings.data_dir) / "memory")
