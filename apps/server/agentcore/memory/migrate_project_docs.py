"""One-time ``AgentCore/文档/项目/`` → documents-entry migration (记忆 · 三分取消 步 3).

Thick folder dossiers landed on the workspace disk only because they were born as
stage artifacts sharing ``stage_dirs`` with ``research`` / ``debate`` / ``reviews``.
They are entries now — scoped to the folder they were written for, ``on_demand``
生效档 — so this pass reads each folder workspace **once** and files them into the
documents tree. Deliberately *not* a two-way sync: after the pass the directory is
gone and ``文档/`` is a pure product directory again.

Disk originals are **moved** to ``AgentCore/文档/已迁入记忆/``, neither left in place
nor deleted. Leaving them is the worst of the three: the user still sees a file he can
edit that no longer feeds anything (a zombie copy). Deleting is destructive inside what
is, in 本机传统模式, the user's own directory — even though the AI wrote the file.

Properties (照 ``migrate_documents`` 先例):

- **one-time + idempotent**: an entry whose stored body is byte-identical to the file's
  counts as already imported, so a run that died between "entry written" and "original
  archived" retries the move without forking a ``-2`` duplicate.
- **loses no data on failure**: per-folder AND per-file best-effort; a file is archived
  only after its entry is written, and nothing is ever deleted.

**Runs after the tree migration**: dossiers are read from the post-§5.4 location
``workspaces/<user>/tree/<rel_path>/``, so ``scripts/migrate_workspace_tree.py`` has to
have moved the directories first. Out of order this pass finds nothing anywhere, and
because it is a one-shot nobody re-runs, a silent zero would be permanent data loss —
hence ``folders_pending_tree_migration`` in the stats and the non-zero exit in
``scripts/migrate_project_docs.py``.

**Reach boundary**: only cloud folders (``folders.rel_path IS NOT NULL``) are visible to
a server-side pass. A local-bound folder's files live on the user's own disk behind the
desktop workspace channel, which needs an online device — those are out of scope here.
"""

from __future__ import annotations

import contextlib
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from agentcore.core.logging import get_logger
from agentcore.documents.frontmatter import set_entry_frontmatter_total
from agentcore.memory.store import MemoryStore, topic_path
from agentcore.workspace.stage_dirs import AGENTCORE_ROOT, DOCS_DIR_NAME

logger = get_logger(__name__)

# The retired thick-dossier directory. A private literal on purpose: it is no longer
# part of the workspace layout (``stage_dirs`` knows only research/debate/reviews),
# it is only the input of this one-shot pass.
LEGACY_PROJECT_DOCS_DIR_NAME = "项目"

# Where the disk originals land — named so a user browsing the tree can tell at a
# glance that these files no longer feed anything.
MIGRATED_DOCS_DIR_NAME = "已迁入记忆"

# Enough suffixes for any realistic same-name pile-up; a hard stop keeps a pathological
# tree from spinning forever.
_MAX_NAME_ATTEMPTS = 100


@dataclass(frozen=True)
class ProjectDocsMigrationStats:
    """Outcome counters for one ``文档/项目/`` → entries pass.

    The first three exist so the caller can tell "nothing to do" apart from "swept the
    wrong paths": this pass reads the *post*-§5.4 location ``tree/<rel_path>/``, so
    running it before the tree migration finds no directory anywhere and would otherwise
    report a flawless zero. ``users_on_disk`` is what keeps that alarm off a deployment
    that simply has not written anything yet.
    """

    folders_considered: int = 0
    folders_pending_tree_migration: int = 0
    users_on_disk: int = 0
    workspaces_scanned: int = 0
    workspaces_with_dossiers: int = 0
    entries_imported: int = 0
    entries_already_present: int = 0
    files_archived: int = 0
    files_failed: int = 0

    def __add__(self, other: ProjectDocsMigrationStats) -> ProjectDocsMigrationStats:
        return ProjectDocsMigrationStats(
            folders_considered=self.folders_considered + other.folders_considered,
            folders_pending_tree_migration=(
                self.folders_pending_tree_migration + other.folders_pending_tree_migration
            ),
            users_on_disk=self.users_on_disk + other.users_on_disk,
            workspaces_scanned=self.workspaces_scanned + other.workspaces_scanned,
            workspaces_with_dossiers=(
                self.workspaces_with_dossiers + other.workspaces_with_dossiers
            ),
            entries_imported=self.entries_imported + other.entries_imported,
            entries_already_present=(
                self.entries_already_present + other.entries_already_present
            ),
            files_archived=self.files_archived + other.files_archived,
            files_failed=self.files_failed + other.files_failed,
        )


def _entry_slug(rel: str) -> str:
    """``深/层/案.md`` → ``深_层_案`` (dossier writes were already flattened on land)."""
    stem = rel[: -len(".md")] if rel.lower().endswith(".md") else rel
    return stem.replace("/", "_").strip() or "untitled"


def _dossier_files(source: Path) -> list[tuple[Path, str]]:
    """``(path, source-relative POSIX path)`` for every file under the legacy dir."""
    out: list[tuple[Path, str]] = []
    for path in sorted(source.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        out.append((path, path.relative_to(source).as_posix()))
    return out


def _free_archive_path(target: Path) -> Path:
    """``a.md`` → ``a.md`` / ``a-2.md`` / … so archiving never clobbers."""
    if not target.exists():
        return target
    for n in range(2, _MAX_NAME_ATTEMPTS + 2):
        candidate = target.with_name(f"{target.stem}-{n}{target.suffix}")
        if not candidate.exists():
            return candidate
    raise FileExistsError(f"归档位已满：{target}")


async def _resolve_entry_name(
    store: MemoryStore,
    *,
    user_id: str,
    folder_id: str,
    slug: str,
    content: str,
) -> tuple[str, bool]:
    """Pick this dossier's note name; second element is "already imported".

    A same-name entry whose body is byte-identical is this very file from an earlier
    run that died before archiving the original — re-importing it would fork a fresh
    ``-2`` duplicate on every retry. A same-name entry with *different* content is a
    genuine collision with someone else's topic note, which must not be clobbered.
    """
    for n in range(1, _MAX_NAME_ATTEMPTS + 1):
        name = topic_path(slug if n == 1 else f"{slug}-{n}")
        current = await store.load(user_id, name, folder_id)
        if not current:
            return name, False
        if current == content:
            return name, True
    raise ValueError(f"主题条目重名过多，放弃迁移：{slug}")


def _archive_file(path: Path, *, archive_root: Path, rel: str) -> None:
    """Move one original under the archive dir, keeping its relative structure."""
    target = archive_root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(path), str(_free_archive_path(target)))


def _remove_empty_tree(source: Path) -> None:
    """Drop the (now empty) legacy dir bottom-up; leftovers just stay."""
    for path in sorted((p for p in source.rglob("*") if p.is_dir()), reverse=True):
        with contextlib.suppress(OSError):
            path.rmdir()
    try:
        source.rmdir()
    except OSError as e:
        logger.warning(
            "memory.migrate_project_docs_dir_retained", path=str(source), error=str(e)
        )


async def migrate_workspace_project_docs(
    root: Path,
    *,
    user_id: str,
    folder_id: str,
    store: MemoryStore | None = None,
) -> ProjectDocsMigrationStats:
    """Import one folder workspace's thick dossiers, then archive the originals.

    ``root`` is the workspace directory. Every ``*.md`` becomes an ``on_demand``
    ``主题/<slug>.md`` entry scoped to ``folder_id``; other file types were never
    injectable entries, so they are archived unchanged. Never raises.
    """
    if store is None:
        from agentcore.memory.store import default_memory_store

        store = default_memory_store()

    docs_root = root / AGENTCORE_ROOT / DOCS_DIR_NAME
    source = docs_root / LEGACY_PROJECT_DOCS_DIR_NAME
    if not source.is_dir():
        return ProjectDocsMigrationStats(workspaces_scanned=1)

    files = _dossier_files(source)
    if not files:
        _remove_empty_tree(source)
        return ProjectDocsMigrationStats(workspaces_scanned=1, workspaces_with_dossiers=1)

    archive_root = docs_root / MIGRATED_DOCS_DIR_NAME
    imported = already = archived = failed = 0
    for path, rel in files:
        try:
            if rel.lower().endswith(".md"):
                body = path.read_text(encoding="utf-8")
                content, _ = set_entry_frontmatter_total(body, apply="on_demand")
                name, present = await _resolve_entry_name(
                    store,
                    user_id=user_id,
                    folder_id=folder_id,
                    slug=_entry_slug(rel),
                    content=content,
                )
                if present:
                    already += 1
                else:
                    await store.save(user_id, name, content, folder_id)
                    imported += 1
            # Archive only after the entry landed — a failed import leaves the file
            # exactly where it was, so the next run picks it up again.
            _archive_file(path, archive_root=archive_root, rel=rel)
            archived += 1
        except Exception as e:  # noqa: BLE001 - per-file best-effort; original untouched
            failed += 1
            logger.warning(
                "memory.migrate_project_docs_file_failed",
                user_id=user_id,
                folder_id=folder_id,
                path=rel,
                error=str(e),
            )
    _remove_empty_tree(source)
    return ProjectDocsMigrationStats(
        workspaces_scanned=1,
        workspaces_with_dossiers=1,
        entries_imported=imported,
        entries_already_present=already,
        files_archived=archived,
        files_failed=failed,
    )


async def migrate_all_project_docs(
    *,
    session_factory: Callable | None = None,
    store: MemoryStore | None = None,
) -> ProjectDocsMigrationStats:
    """Sweep every live cloud folder workspace (see the module docstring's boundary).

    Never raises: a folder whose workspace cannot be read is logged and skipped, and
    an out-of-order run is *counted* rather than raised — the caller decides the exit
    code, so a partial sweep still imports whatever is already in the tree.
    """
    if session_factory is None:
        from agentcore.db.base import async_session_factory

        session_factory = async_session_factory

    from sqlalchemy import select

    from agentcore.db.models.conversations import Folder
    from agentcore.workspace.layout import discover_user_ids, flat_folder_dir
    from agentcore.workspace.locate import workspace_root_path

    try:
        async with session_factory() as session:
            rows = (
                await session.execute(
                    select(Folder.id, Folder.user_id, Folder.rel_path).where(
                        Folder.deleted_at.is_(None),
                        Folder.rel_path.is_not(None),
                    )
                )
            ).all()
    except Exception as e:  # noqa: BLE001 - a broken sweep must not abort a deploy step
        logger.warning("memory.migrate_project_docs_scan_failed", error=str(e))
        return ProjectDocsMigrationStats()

    stats = ProjectDocsMigrationStats()
    pending = 0
    for folder_id, user_id, rel_path in rows:
        try:
            # Still parked in the pre-§5.4 flat layout ⇒ the tree migration has not run
            # for this folder, and the tree path below cannot find its dossiers.
            if flat_folder_dir(user_id=user_id, folder_id=folder_id).is_dir():
                pending += 1
            root = workspace_root_path(
                user_id=user_id, folder_rel_path=rel_path, conversation_id=""
            )
            if not root.is_dir():
                continue
            stats = stats + await migrate_workspace_project_docs(
                root, user_id=user_id, folder_id=folder_id, store=store
            )
        except Exception as e:  # noqa: BLE001 - per-folder best-effort
            logger.warning(
                "memory.migrate_project_docs_folder_failed",
                user_id=user_id,
                folder_id=folder_id,
                error=str(e),
            )
    stats = stats + ProjectDocsMigrationStats(
        folders_considered=len(rows),
        folders_pending_tree_migration=pending,
        users_on_disk=len(discover_user_ids()),
    )
    if stats.workspaces_with_dossiers or stats.files_failed or pending:
        logger.info(
            "memory.migrate_project_docs_done",
            folders=stats.folders_considered,
            pending_tree_migration=pending,
            users_on_disk=stats.users_on_disk,
            workspaces=stats.workspaces_scanned,
            with_dossiers=stats.workspaces_with_dossiers,
            imported=stats.entries_imported,
            already_present=stats.entries_already_present,
            archived=stats.files_archived,
            failed=stats.files_failed,
        )
    return stats
