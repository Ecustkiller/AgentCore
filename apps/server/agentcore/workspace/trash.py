"""In-workspace soft-delete zone for backends without an OS recycle bin.

Used by ``ServerWorkspace`` (cloud + sidecar): default ``delete`` moves the
target under ``AgentCore/trash/<id>/`` and writes ``meta.json`` with the
original relative path so :func:`restore_from_trash` can put it back. Local
Electron channels prefer ``shell.trashItem`` instead (OS recycle bin — **no**
product one-click restore); this module is the cloud/sidecar path and the
local no-OS-trash fallback.

Internal zones (``AgentCore/{index,trash,baselines}``) are path-aware system
noise — trash entries never appear in agent listings / indexes. Hard-delete
bypass applies only to those zones, **not** the whole ``AgentCore/`` tree
(deleting rules/memory/docs must remain soft-deletable).

Retention aligns with ``settings.workspace_retention_days`` (workspace soft-delete
grace): expired entries are purged on list and refused on restore.
"""

from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.workspace._paths import is_access_denied_oserror, is_internal_zone_relpath
from agentcore.workspace.protocol import (
    AlreadyExists,
    OutsideWorkspace,
    PathNotFound,
    WorkspaceIOError,
)
from agentcore.workspace.stage_dirs import TRASH_REL

logger = get_logger(__name__)

_META_NAME = "meta.json"
_CONTENT_NAME = "content"


def _rmtree_retry(path: Path) -> None:
    """``shutil.rmtree`` with short retries for Windows sharing violations."""
    delays = (0.0, 0.05, 0.2, 0.5)
    last: OSError | None = None
    for delay in delays:
        if delay:
            time.sleep(delay)
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as e:
            last = e
            if not is_access_denied_oserror(e):
                raise
    assert last is not None
    raise last


def is_internal_zone_path(rel_path: str) -> bool:
    """True when ``rel_path`` is an AgentCore internal zone or under one.

    Alias kept for call-site clarity (hard-delete bypass). Does **not** match
    bare ``AgentCore/`` or ``AgentCore/规则|记忆|文档``.
    """
    return is_internal_zone_relpath(rel_path)


# Backward-compatible name used by older call sites / tests.
is_trash_or_agentcore_path = is_internal_zone_path


def trash_retention_days() -> int:
    """Retention window for AgentCore/trash entries (days).

    Same knob as soft-deleted workspace purge (``workspace_retention_days``).
    """
    return max(0, int(settings.workspace_retention_days))


@dataclass(frozen=True)
class TrashEntry:
    """One reversible soft-delete under ``AgentCore/trash/<id>/``."""

    entry_id: str
    original_path: str
    name: str
    is_dir: bool
    deleted_at: datetime


class TrashNotFound(PathNotFound):
    """No trash entry with this id (or meta/content missing)."""


class TrashExpiredError(WorkspaceIOError):
    """Entry older than the retention window."""


def trash_dest_under_target(*, root: Path, target: Path) -> bool:
    """True when ``AgentCore/trash`` would land inside ``target`` (self-nest risk).

    Lexical / resolve-based — does not require the trash dir to exist yet.
    """
    trash_root = (root / Path(*TRASH_REL.split("/"))).resolve()
    try:
        trash_root.relative_to(target.resolve())
        return True
    except ValueError:
        return False


def soft_delete_to_trash(*, root: Path, target: Path, original_rel: str) -> str:
    """Move ``target`` into the workspace trash zone; return the trash entry id.

    Layout::

        AgentCore/trash/<id>/
          meta.json   # original_path, deleted_at, is_dir, name
          content     # file, or directory tree

    Raises ``WorkspaceIOError`` on I/O failure, or when the trash destination
    would nest under ``target`` (never ``shutil.move`` into self).
    """
    trash_root = root / Path(*TRASH_REL.split("/"))
    if trash_dest_under_target(root=root, target=target):
        raise WorkspaceIOError("不能软删到自身子树内的回收区（会自嵌套）")

    entry_id = new_id()
    entry_dir = trash_root / entry_id
    try:
        entry_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e

    dest = entry_dir / _CONTENT_NAME
    is_dir = target.is_dir()
    try:
        shutil.move(str(target), str(dest))
    except OSError as e:
        shutil.rmtree(entry_dir, ignore_errors=True)
        raise WorkspaceIOError(str(e)) from e

    meta = {
        "original_path": original_rel.replace("\\", "/"),
        "deleted_at": datetime.now(UTC).isoformat(),
        "is_dir": is_dir,
        "name": target.name,
    }
    try:
        (entry_dir / _META_NAME).write_text(
            json.dumps(meta, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    except OSError as e:
        # Payload already under trash; leave it rather than risk a second move.
        raise WorkspaceIOError(str(e)) from e
    return entry_id


def soft_delete_expanding_trash_ancestor(*, root: Path, target: Path) -> None:
    """Soft-delete a path that contains ``AgentCore/trash`` by expanding children.

    Order matters: hard-clear internal zones first (so a fresh trash can receive
    soft-deletes), then soft-delete each non-zone child. Soft-deletes recreate
    ``AgentCore/trash`` under ``target``, so the ancestor shell is left in place
    when only internal zones remain. Never moves the whole tree into its own trash.
    """
    if not target.is_dir():
        raise WorkspaceIOError("不能软删到自身子树内的回收区（会自嵌套）")

    try:
        children = list(target.iterdir())
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e

    root_resolved = root.resolve()
    zone_children: list[tuple[Path, str]] = []
    soft_children: list[tuple[Path, str]] = []
    for child in children:
        try:
            child_rel = child.resolve().relative_to(root_resolved).as_posix()
        except ValueError as e:
            raise OutsideWorkspace(str(child)) from e
        if is_internal_zone_path(child_rel):
            zone_children.append((child, child_rel))
        else:
            soft_children.append((child, child_rel))

    for child, child_rel in zone_children:
        try:
            if child.is_dir():
                _rmtree_retry(child)
            elif child.exists():
                child.unlink()
        except OSError as e:
            # Windows sharing violation on ``AgentCore/index/code_search.db``. Root cause
            # is NOT in-flight maintenance (``drop_index_registry`` settles it first):
            # ``BM25Index`` opens a connection per op via ``with sqlite3.connect(...)``,
            # and that context manager commits WITHOUT closing — handle release is left to
            # refcounting and lags on Windows. Fixing it means owning connection lifetime
            # in ``bm25.py``; until then, skip: internal zones are regenerable derived
            # state, and failing the user's delete over a stale cache file is worse.
            if is_access_denied_oserror(e) and is_internal_zone_relpath(child_rel):
                logger.warning(
                    "workspace.internal_zone_clear_skipped",
                    path=child_rel,
                    error=str(e),
                )
                continue
            raise WorkspaceIOError(str(e)) from e

    for child, child_rel in soft_children:
        soft_delete_to_trash(root=root, target=child, original_rel=child_rel)

    if not target.exists():
        return
    if not target.is_dir():
        try:
            target.unlink()
        except OSError as e:
            raise WorkspaceIOError(str(e)) from e
        return
    # Soft-deletes recreate AgentCore/trash under ``target`` — leave the shell.
    try:
        remaining = list(target.iterdir())
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e
    leftovers: list[str] = []
    for child in remaining:
        try:
            child_rel = child.resolve().relative_to(root_resolved).as_posix()
        except ValueError as e:
            raise OutsideWorkspace(str(child)) from e
        if not is_internal_zone_path(child_rel):
            leftovers.append(child.name)
    if leftovers:
        raise WorkspaceIOError(
            f"软删展开后目录仍有残留：{', '.join(leftovers[:5])}"
        )


def list_trash_entries(
    *, root: Path, retention_days: int | None = None
) -> list[TrashEntry]:
    """List AgentCore/trash entries newest-first; purge expired as a side effect.

    Skips corrupt / incomplete entry dirs. Does **not** invent OS-recycle-bin
    entries — only on-disk ``AgentCore/trash`` payloads.
    """
    days = trash_retention_days() if retention_days is None else max(0, retention_days)
    trash_root = root / Path(*TRASH_REL.split("/"))
    if not trash_root.is_dir():
        return []

    cutoff = datetime.now(UTC) - timedelta(days=days) if days > 0 else None
    entries: list[TrashEntry] = []
    try:
        children = list(trash_root.iterdir())
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e

    for entry_dir in children:
        if not entry_dir.is_dir():
            continue
        parsed = _read_entry(entry_dir)
        if parsed is None:
            continue
        if cutoff is not None and parsed.deleted_at < cutoff:
            shutil.rmtree(entry_dir, ignore_errors=True)
            continue
        entries.append(parsed)

    entries.sort(key=lambda e: e.deleted_at, reverse=True)
    return entries


def restore_from_trash(
    *, root: Path, entry_id: str, retention_days: int | None = None
) -> str:
    """Move trash ``content`` back to ``original_path``; return that relative path.

    Raises:
        TrashNotFound — unknown / incomplete entry
        TrashExpiredError — past retention
        AlreadyExists — destination path already occupied
        OutsideWorkspace — stored original_path escapes the workspace root
        WorkspaceIOError — I/O failure
    """
    if not entry_id or "/" in entry_id or "\\" in entry_id or entry_id in (".", ".."):
        raise TrashNotFound(entry_id or "")

    days = trash_retention_days() if retention_days is None else max(0, retention_days)
    trash_root = root / Path(*TRASH_REL.split("/"))
    entry_dir = trash_root / entry_id
    parsed = _read_entry(entry_dir)
    if parsed is None:
        raise TrashNotFound(entry_id)

    if days > 0:
        cutoff = datetime.now(UTC) - timedelta(days=days)
        if parsed.deleted_at < cutoff:
            shutil.rmtree(entry_dir, ignore_errors=True)
            raise TrashExpiredError(f"软删条目已超过 {days} 天保留期")

    dest = _resolve_restore_dest(root, parsed.original_path)
    if dest.exists():
        raise AlreadyExists(parsed.original_path)

    content = entry_dir / _CONTENT_NAME
    if not content.exists():
        raise TrashNotFound(entry_id)

    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(content), str(dest))
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e

    shutil.rmtree(entry_dir, ignore_errors=True)
    return parsed.original_path


def _read_entry(entry_dir: Path) -> TrashEntry | None:
    meta_path = entry_dir / _META_NAME
    content = entry_dir / _CONTENT_NAME
    if not meta_path.is_file() or not content.exists():
        return None
    try:
        raw = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    original = raw.get("original_path")
    name = raw.get("name")
    deleted_raw = raw.get("deleted_at")
    if not isinstance(original, str) or not original.strip():
        return None
    if not isinstance(name, str) or not name:
        name = Path(original.replace("\\", "/")).name or entry_dir.name
    if not isinstance(deleted_raw, str):
        return None
    try:
        deleted_at = datetime.fromisoformat(deleted_raw)
    except ValueError:
        return None
    if deleted_at.tzinfo is None:
        deleted_at = deleted_at.replace(tzinfo=UTC)
    else:
        deleted_at = deleted_at.astimezone(UTC)
    return TrashEntry(
        entry_id=entry_dir.name,
        original_path=original.replace("\\", "/"),
        name=name,
        is_dir=bool(raw.get("is_dir", content.is_dir())),
        deleted_at=deleted_at,
    )


def _resolve_restore_dest(root: Path, original_rel: str) -> Path:
    rel = original_rel.replace("\\", "/").strip().lstrip("/")
    if not rel or rel in (".", "..") or ".." in Path(rel).parts:
        raise OutsideWorkspace(original_rel)
    if is_internal_zone_relpath(rel):
        raise OutsideWorkspace(original_rel)
    root_resolved = root.resolve()
    dest = (root_resolved / Path(*rel.split("/"))).resolve()
    try:
        dest.relative_to(root_resolved)
    except ValueError as e:
        raise OutsideWorkspace(original_rel) from e
    return dest
