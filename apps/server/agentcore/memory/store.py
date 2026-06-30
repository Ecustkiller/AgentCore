"""Long-term memory storage (folder- and scope-addressed).

Long-term memory is the markdown body of the user's `ai_maintained` rule file(s)
(see docs/03-AI核心/Agent记忆与知识系统.md §1.4 / §5.3). The cloud file-tree / Document
subsystem that will ultimately host these files does not exist yet, so the MVP backs
them with a per-user *folder* under the server data dir — one markdown file per memory
note, addressed by a path relative to that folder.

Phase 2 of「记忆文件夹化」(Agent记忆与知识系统 §1.4 / §5.3) adds two axes on top of
the phase-1 single-folder layout, both behind the same ``MemoryStore`` seam:

- **作用域 (scope)**: a note lives either GLOBAL (the user's cloud root — injected into
  every conversation) or under a PROJECT folder (only injected for conversations bound to
  that folder). ``scope=None`` = global (the phase-1 behavior, unchanged → zero migration);
  ``scope=<folder_id>`` = that project. 位置即作用域: complements §5.3, no manual switch.
- **偏好/画像 二分**: the always-injected core splits into ``PREFERENCES_MEMORY_FILE``
  (沟通/工作习惯, soft, GLOBAL-only) and ``CORE_MEMORY_FILE`` (技术栈/关于用户的事实, can be
  global OR project). Different change-reasons → different files → different CAS.

Storage stays hidden behind ``MemoryStore`` so the eventual swap to the cloud file tree is
a one-liner (then project memory = a folder's ``ai_maintained`` rule files, §5.4 终点形态).
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


# A memory note's SCOPE (Agent记忆与知识系统 §1.4): ``None`` = global (the user's cloud root,
# injected into every conversation); a ``str`` is a ``folder_id`` = that project's scope
# (injected only for conversations bound to that folder). 位置即作用域 — no manual switch.
MemoryScope = str | None

# The always-injected PROFILE core (§四「偏好/画像 二分」): durable facts ABOUT the user —
# 技术栈与工具 + 关于用户的事实. Can be GLOBAL or PROJECT (a project's facts: "本仓用 Rust").
CORE_MEMORY_FILE = "画像.md"

# The always-injected PREFERENCES core (§四): how to work WITH the user — 沟通偏好 + 工作习惯.
# Soft, occasionally-tuned, universal → GLOBAL-only (never copied into each project, §二).
PREFERENCES_MEMORY_FILE = "偏好.md"

# The two always-injected core files, in stable injection order (preferences then profile):
# both ride every prompt's <rules>; ordering is load-bearing for DeepSeek prefix caching.
ALWAYS_MEMORY_FILES = (PREFERENCES_MEMORY_FILE, CORE_MEMORY_FILE)

# On-demand topic notes (§三 / §六): ``<scope>/主题/<slug>.md`` — episodic / procedural /
# project knowledge the agent pulls only when relevant (vs the always-injected core).
TOPIC_DIR = "主题"

# Reserved subdir under a user's global folder that holds the PROJECT-scoped layers
# (``<user>/_folders/<folder_id>/…``). Leading underscore + ``_safe_segment`` keep it from
# ever colliding with a real note (core files are 偏好.md/画像.md; topics live under 主题/),
# and the global ``list`` skips it so project notes never leak into the global layer.
_PROJECT_CONTAINER = "_folders"


def topic_path(slug: str) -> str:
    """The relative memory path for a topic note (``主题/<slug>.md``)."""
    return f"{TOPIC_DIR}/{slug}.md"


def is_topic_path(path: str) -> bool:
    """Whether ``path`` addresses an on-demand topic note (under ``主题/``)."""
    return path.startswith(f"{TOPIC_DIR}/")


def topic_slug(path: str) -> str:
    """The bare slug of a topic note path (``主题/部署.md`` → ``部署``)."""
    return path[len(TOPIC_DIR) + 1 :].removesuffix(".md")


_SEGMENT_SPLIT = re.compile(r"[\\/]+")


def memory_version(markdown: str) -> str:
    """A content-addressed version tag for a memory file (the editor's CAS baseline).

    A SHA-256 of the exact bytes, so it is store-agnostic (works the same once the
    file tree backs it) and stable: the same content always yields the same tag, so a
    write whose ``baseline`` still matches the current tag is safe, while a tag drift
    means the offline consolidation (or another device) changed the file underneath —
    the write reports a conflict instead of clobbering it. Empty body has its own
    stable tag, so a first write (baseline = the empty tag) is conflict-free. The tag
    is now per file: a manual edit of one note and an offline pass over another no
    longer share a single CAS baseline (§五「每文件 CAS」).
    """
    return hashlib.sha256(markdown.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class MemoryFileMeta:
    """One file in a user's memory folder: its relative path + per-file CAS tag."""

    path: str  # relative to the user's memory folder, e.g. "画像.md"
    version: str  # per-file CAS = ``memory_version`` of the file's bytes


class MemoryStore(Protocol):
    """Loads/saves the markdown files in one (user, scope) long-term-memory layer.

    Addressed by ``(user_id, path, scope)`` where ``path`` is relative to that scope's
    memory folder (e.g. ``"画像.md"``) and ``scope`` selects the layer: ``None`` = global
    (default → the phase-1 behavior, unchanged), a ``folder_id`` = that project. ``load``
    of a missing file returns "" so callers never have to branch on existence; ``list`` of
    one scope never returns notes from another (global ``list`` skips the project layers).
    """

    async def list(self, user_id: str, scope: MemoryScope = None) -> list[MemoryFileMeta]:
        """List one scope's memory files (empty when there are none yet)."""
        ...

    async def load(self, user_id: str, path: str, scope: MemoryScope = None) -> str:
        """Return one memory file's markdown in ``scope``, or "" if it does not exist."""
        ...

    async def save(self, user_id: str, path: str, markdown: str, scope: MemoryScope = None) -> None:
        """Persist one memory file's markdown in ``scope`` (creating the folder if needed)."""
        ...

    async def delete(self, user_id: str, path: str, scope: MemoryScope = None) -> None:
        """Delete one memory file in ``scope`` (no-op if it does not exist)."""
        ...

    async def project_scopes(self, user_id: str) -> list[str]:
        """List ``folder_id``s whose PROJECT layer holds any memory (for the editor rail)."""
        ...


class FileMemoryStore:
    """MVP MemoryStore: a per-(user, scope) folder of markdown files under a base directory.

    Layout (Agent记忆与知识系统 §1.4):
    - GLOBAL (``scope=None``): ``<base>/<user_id>/<path>`` — unchanged from phase 1, so
      existing memory IS the global layer (zero migration).
    - PROJECT (``scope=<folder_id>``): ``<base>/<user_id>/_folders/<folder_id>/<path>`` —
      nested under the reserved ``_PROJECT_CONTAINER`` so the global ``list`` (which skips
      that subdir) never returns a project's notes, and each project is isolated.

    File I/O is synchronous but the files are tiny (a few KB), so it runs inline. Failures
    are logged and degrade to empty / no-op so memory never breaks a turn.

    Migration: a user whose memory predates the folder layout has a flat
    ``<base>/<user_id>.md``. The first access migrates it into the GLOBAL ``画像.md`` — same
    bytes, so the CAS tag is unchanged and an in-flight editor baseline still matches —
    then removes the old file. Idempotent (skipped once the folder exists) and best-effort
    (any failure leaves the old file in place: degrade, never lose data). The 偏好/画像 split
    is left to organic re-routing (consolidation + the editor's combine/split), not a
    destructive batch pass — old preference sections in 画像.md keep being injected meanwhile.
    Migration is fully synchronous (no ``await``), so within the single-process async MVP it
    runs atomically and cannot interleave with another access.
    """

    def __init__(self, base_dir: str | Path) -> None:
        self._base = Path(base_dir)

    @staticmethod
    def _safe_segment(segment: str) -> str:
        """Neutralize traversal / separator injection in a single path component."""
        cleaned = segment.replace("/", "_").replace("\\", "_").replace("..", "_").strip()
        return cleaned or "_"

    def _user_dir(self, user_id: str) -> Path:
        # user_id is a server-issued UUID; still neutralize any path separators.
        return self._base / self._safe_segment(user_id)

    def _scope_dir(self, user_id: str, scope: MemoryScope) -> Path:
        """The root folder for one (user, scope) layer.

        Global = the user folder (phase-1 layout); a project = nested under the reserved
        container so it stays isolated and invisible to the global ``list``. ``scope`` is a
        server-issued ``folder_id`` UUID, but it is still per-segment sanitized.
        """
        base = self._user_dir(user_id)
        if scope is None:
            return base
        return base / _PROJECT_CONTAINER / self._safe_segment(scope)

    def _path(self, user_id: str, rel: str, scope: MemoryScope = None) -> Path:
        # Sanitize every segment so a crafted path (.., absolute, separator injection)
        # can never escape the (user, scope) folder.
        target = self._scope_dir(user_id, scope)
        for part in _SEGMENT_SPLIT.split(rel):
            if part in ("", "."):
                continue
            target = target / self._safe_segment(part)
        return target

    def _legacy_path(self, user_id: str) -> Path:
        return self._base / f"{self._safe_segment(user_id)}.md"

    def _migrate_if_needed(self, user_id: str) -> None:
        user_dir = self._user_dir(user_id)
        if user_dir.exists():
            return  # already folder-shaped (fast path / idempotent)
        legacy = self._legacy_path(user_id)
        if not legacy.exists():
            return  # brand-new user; nothing to migrate
        try:
            content = legacy.read_text(encoding="utf-8")
            user_dir.mkdir(parents=True, exist_ok=True)
            (user_dir / CORE_MEMORY_FILE).write_text(content, encoding="utf-8")
            legacy.unlink(missing_ok=True)
            logger.info("memory.migrated_to_folder", user_id=user_id)
        except OSError as e:
            logger.warning("memory.migrate_failed", user_id=user_id, error=str(e))

    async def list(self, user_id: str, scope: MemoryScope = None) -> list[MemoryFileMeta]:
        self._migrate_if_needed(user_id)
        scope_dir = self._scope_dir(user_id, scope)
        if not scope_dir.exists():
            return []
        metas: list[MemoryFileMeta] = []
        try:
            for path in sorted(scope_dir.rglob("*.md")):
                if not path.is_file():
                    continue
                rel = path.relative_to(scope_dir).as_posix()
                # Global scope must not surface project notes nested under the reserved
                # container; project scopes are already rooted inside their own dir.
                if scope is None and rel.split("/", 1)[0] == _PROJECT_CONTAINER:
                    continue
                version = memory_version(path.read_text(encoding="utf-8"))
                metas.append(MemoryFileMeta(path=rel, version=version))
        except OSError as e:
            logger.warning("memory.list_failed", user_id=user_id, error=str(e))
        return metas

    async def load(self, user_id: str, path: str, scope: MemoryScope = None) -> str:
        self._migrate_if_needed(user_id)
        target = self._path(user_id, path, scope)
        try:
            return target.read_text(encoding="utf-8") if target.exists() else ""
        except OSError as e:
            logger.warning("memory.load_failed", user_id=user_id, error=str(e))
            return ""

    async def save(self, user_id: str, path: str, markdown: str, scope: MemoryScope = None) -> None:
        self._migrate_if_needed(user_id)
        target = self._path(user_id, path, scope)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(markdown, encoding="utf-8")
        except OSError as e:
            logger.warning("memory.save_failed", user_id=user_id, error=str(e))

    async def delete(self, user_id: str, path: str, scope: MemoryScope = None) -> None:
        self._migrate_if_needed(user_id)
        target = self._path(user_id, path, scope)
        try:
            target.unlink(missing_ok=True)
        except OSError as e:
            logger.warning("memory.delete_failed", user_id=user_id, error=str(e))

    async def project_scopes(self, user_id: str) -> list[str]:
        """List ``folder_id``s whose PROJECT layer holds any memory file (editor rail §P2).

        Scans the reserved ``_folders`` container for subdirs holding ≥1 ``.md`` — i.e. the
        projects the offline consolidation has actually written memory for — so the「文件」
        page surfaces a「本项目记忆」node only where there IS something to edit. ``folder_id``
        is a server UUID, so ``_safe_segment`` is a no-op and the dir name IS the id.
        Degrades to [] on any I/O error (memory never breaks the page).
        """
        self._migrate_if_needed(user_id)
        container = self._user_dir(user_id) / _PROJECT_CONTAINER
        if not container.exists():
            return []
        scopes: list[str] = []
        try:
            for child in sorted(container.iterdir()):
                if child.is_dir() and any(child.rglob("*.md")):
                    scopes.append(child.name)
        except OSError as e:
            logger.warning("memory.project_scopes_failed", user_id=user_id, error=str(e))
        return scopes


def default_memory_store() -> FileMemoryStore:
    """Build the MVP file-backed store under `<settings.data_dir>/memory`."""
    from agentcore.config import settings

    return FileMemoryStore(Path(settings.data_dir) / "memory")
