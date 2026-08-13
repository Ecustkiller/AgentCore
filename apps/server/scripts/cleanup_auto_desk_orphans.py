"""One-shot cleanup: orphaned bare-chat auto cloud desks.

``Conversation.auto_desk_folder_id`` has no FK and historically was not cleared
on project delete. Stock can contain two orphan shapes:

1. Pointer orphan — ``auto_desk_folder_id`` points at a hard-deleted **or**
   soft-deleted Folder row → clear the column to NULL.
2. Ghost directory — ``workspaces/<user>/<folder_id>/`` exists on disk but no
   ``folders`` row remains (purge removed the row; file tools later recreated
   the tree) → report in dry-run; ``--apply`` deletes the directory.

``--apply`` does an unrecoverable ``rmtree``, so **which directories even count** is
not this script's judgment to make: it asks ``workspace.layout``, the single source for
"who is a user dir, who is a top-level system segment". What separates a ghost from an
un-migrated folder is the ``folders`` join below, not the scan.

Run from ``apps/server``::

    # preview (default)
    uv run python scripts/cleanup_auto_desk_orphans.py

    # apply pointer clears + ghost dir deletes
    uv run python scripts/cleanup_auto_desk_orphans.py --apply
"""

from __future__ import annotations

import argparse
import asyncio
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select, update

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.models import Conversation, Folder
from agentcore.workspace.layout import iter_flat_folder_dirs, workspaces_base_path

logger = get_logger(__name__)

__all__ = [
    "CleanupStats",
    "GhostDirReport",
    "cleanup_auto_desk_orphans",
    "folder_is_pointer_orphan",
    "summarize_workspace_dir",
]


@dataclass(frozen=True)
class GhostDirReport:
    """Human-readable preview of a ghost workspace directory to delete."""

    user_id: str
    folder_id: str
    path: str
    top_level_entries: tuple[str, ...]
    file_count: int
    approx_bytes: int


@dataclass
class CleanupStats:
    """Outcome counters for an orphan cleanup run."""

    pointers_scanned: int = 0
    pointers_ok: int = 0
    pointers_cleared: int = 0
    pointers_failed: int = 0
    ghost_dirs_scanned: int = 0
    ghost_dirs_found: int = 0
    ghost_dirs_deleted: int = 0
    ghost_dirs_failed: int = 0
    failures: list[str] = field(default_factory=list)
    ghost_reports: list[GhostDirReport] = field(default_factory=list)


def folder_is_pointer_orphan(folder: Folder | None) -> bool:
    """True when the pointed-at Folder is missing or soft-deleted."""
    if folder is None:
        return True
    return folder.deleted_at is not None


def summarize_workspace_dir(path: Path) -> tuple[tuple[str, ...], int, int]:
    """Top-level names + recursive file count / approx byte size for dry-run."""
    if not path.is_dir():
        return (), 0, 0
    try:
        top = tuple(sorted(child.name for child in path.iterdir()))
    except OSError:
        top = ()
    file_count = 0
    approx_bytes = 0
    try:
        for child in path.rglob("*"):
            if not child.is_file():
                continue
            file_count += 1
            try:
                approx_bytes += child.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return top, file_count, approx_bytes


async def list_auto_desk_pointer_rows() -> list[tuple[str, str, str]]:
    """``(conversation_id, user_id, auto_desk_folder_id)`` with a non-empty pointer."""
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(
                    Conversation.id,
                    Conversation.user_id,
                    Conversation.auto_desk_folder_id,
                ).where(Conversation.auto_desk_folder_id.is_not(None))
            )
        ).all()
    out: list[tuple[str, str, str]] = []
    for cid, uid, desk in rows:
        cleaned = desk.strip() if isinstance(desk, str) else ""
        if cleaned:
            out.append((cid, uid, cleaned))
    return out


async def load_folders_by_id(folder_ids: set[str]) -> dict[str, Folder]:
    """Load Folder rows by id, **including** soft-deleted (for orphan detection)."""
    if not folder_ids:
        return {}
    async with async_session_factory() as session:
        rows = (
            await session.execute(select(Folder).where(Folder.id.in_(folder_ids)))
        ).scalars().all()
        return {row.id: row for row in rows}


async def clear_auto_desk_pointer(conversation_id: str) -> None:
    """Set ``auto_desk_folder_id`` to NULL for one conversation."""
    async with async_session_factory() as session:
        await session.execute(
            update(Conversation)
            .where(Conversation.id == conversation_id)
            .values(auto_desk_folder_id=None)
        )
        await session.commit()


async def list_existing_folder_ids(folder_ids: set[str]) -> set[str]:
    """Ids that still have a ``folders`` row (live or soft-deleted)."""
    if not folder_ids:
        return set()
    async with async_session_factory() as session:
        rows = (
            await session.execute(select(Folder.id).where(Folder.id.in_(folder_ids)))
        ).scalars().all()
        return set(rows)


async def _cleanup_pointer_orphans(*, dry_run: bool, stats: CleanupStats) -> None:
    try:
        pointers = await list_auto_desk_pointer_rows()
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_desk.orphan_pointer_list_failed", error=str(e))
        stats.failures.append(f"pointer_list: {e}")
        stats.pointers_failed += 1
        return

    desk_ids = {desk for _, _, desk in pointers}
    try:
        folders = await load_folders_by_id(desk_ids)
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_desk.orphan_folder_load_failed", error=str(e))
        stats.failures.append(f"folder_load: {e}")
        stats.pointers_failed += 1
        return

    for cid, uid, desk_id in pointers:
        stats.pointers_scanned += 1
        try:
            folder = folders.get(desk_id)
            if not folder_is_pointer_orphan(folder):
                stats.pointers_ok += 1
                continue
            reason = "missing" if folder is None else "soft_deleted"
            if dry_run:
                stats.pointers_cleared += 1
                logger.info(
                    "auto_desk.orphan_pointer_would_clear",
                    conversation_id=cid,
                    user_id=uid,
                    auto_desk_folder_id=desk_id,
                    reason=reason,
                )
                continue
            await clear_auto_desk_pointer(cid)
            stats.pointers_cleared += 1
            logger.info(
                "auto_desk.orphan_pointer_cleared",
                conversation_id=cid,
                user_id=uid,
                auto_desk_folder_id=desk_id,
                reason=reason,
            )
        except Exception as e:  # noqa: BLE001 — isolate per conversation
            stats.pointers_failed += 1
            stats.failures.append(f"pointer:{cid}: {e}")
            logger.warning(
                "auto_desk.orphan_pointer_failed",
                conversation_id=cid,
                auto_desk_folder_id=desk_id,
                error=str(e),
            )


async def _cleanup_ghost_dirs(*, dry_run: bool, stats: CleanupStats) -> None:
    # ``iter_flat_folder_dirs`` is the single judgment of "which directory belongs to
    # which user" (``workspace.layout``). It matters that this scan does not roll its
    # own: an allowlist of UUID-shaped user dirs is what keeps ``im/`` — a *sibling*
    # of the user dirs whose children are chat UUIDs — from being read as a user whose
    # every chat is an orphan folder dir, i.e. from ``--apply`` deleting every group
    # chat's attachments.
    candidates = iter_flat_folder_dirs(workspaces_base_path())
    stats.ghost_dirs_scanned = len(candidates)
    if not candidates:
        return

    try:
        existing = await list_existing_folder_ids({fid for _, fid, _ in candidates})
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_desk.orphan_ghost_folder_lookup_failed", error=str(e))
        stats.failures.append(f"ghost_lookup: {e}")
        stats.ghost_dirs_failed += 1
        return

    for user_id, folder_id, path in candidates:
        if folder_id in existing:
            continue
        stats.ghost_dirs_found += 1
        top, file_count, approx_bytes = summarize_workspace_dir(path)
        report = GhostDirReport(
            user_id=user_id,
            folder_id=folder_id,
            path=str(path),
            top_level_entries=top,
            file_count=file_count,
            approx_bytes=approx_bytes,
        )
        stats.ghost_reports.append(report)
        try:
            if dry_run:
                logger.info(
                    "auto_desk.orphan_ghost_would_delete",
                    user_id=user_id,
                    folder_id=folder_id,
                    path=str(path),
                    top_level_entries=list(top),
                    file_count=file_count,
                    approx_bytes=approx_bytes,
                )
                continue
            # The scan hands us the real directory. There is no canonical path to
            # cross-check against any more: a live folder lives at its visible
            # ``tree/<rel_path>``, so an id-named directory here is by definition a
            # leftover the layout no longer addresses (双模式工作区 §5.4).
            target = path
            shutil.rmtree(target, ignore_errors=False)
            stats.ghost_dirs_deleted += 1
            logger.info(
                "auto_desk.orphan_ghost_deleted",
                user_id=user_id,
                folder_id=folder_id,
                path=str(target),
                file_count=file_count,
                approx_bytes=approx_bytes,
            )
        except Exception as e:  # noqa: BLE001 — isolate per directory
            stats.ghost_dirs_failed += 1
            stats.failures.append(f"ghost:{user_id}/{folder_id}: {e}")
            logger.warning(
                "auto_desk.orphan_ghost_delete_failed",
                user_id=user_id,
                folder_id=folder_id,
                path=str(path),
                error=str(e),
            )


async def cleanup_auto_desk_orphans(*, dry_run: bool = True) -> CleanupStats:
    """Clear dangling auto-desk pointers and report/delete ghost workspace dirs.

    Per-item failures are logged and skipped — one bad row/dir must not abort the
    rest. ``dry_run=True`` only reports what would change.
    """
    stats = CleanupStats()
    await _cleanup_pointer_orphans(dry_run=dry_run, stats=stats)
    await _cleanup_ghost_dirs(dry_run=dry_run, stats=stats)
    return stats


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Clear orphaned Conversation.auto_desk_folder_id pointers and "
            "delete ghost workspaces/<user>/<folder_id>/ directories with no folders row."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform clears/deletes (default is dry-run preview only).",
    )
    return parser.parse_args()


def _format_bytes(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KiB"
    return f"{n / (1024 * 1024):.1f} MiB"


def _print_stats(*, dry_run: bool, stats: CleanupStats) -> None:
    mode = "DRY RUN" if dry_run else "APPLIED"
    print(f"\nAuto-desk orphan cleanup ({mode})")
    print(f"  data_dir:                 {settings.data_dir}")
    print(f"  pointers scanned:         {stats.pointers_scanned}")
    print(f"  pointers ok:              {stats.pointers_ok}")
    print(f"  pointers cleared:         {stats.pointers_cleared}")
    print(f"  pointers failed:          {stats.pointers_failed}")
    print(f"  ghost dirs scanned:       {stats.ghost_dirs_scanned}")
    print(f"  ghost dirs found:         {stats.ghost_dirs_found}")
    if not dry_run:
        print(f"  ghost dirs deleted:       {stats.ghost_dirs_deleted}")
    print(f"  ghost dirs failed:        {stats.ghost_dirs_failed}")
    if stats.ghost_reports:
        label = "would delete" if dry_run else "deleted / reported"
        print(f"\n  Ghost directories ({label}):")
        for report in stats.ghost_reports[:50]:
            sample = ", ".join(report.top_level_entries[:8]) or "(empty)"
            if len(report.top_level_entries) > 8:
                sample += ", …"
            print(
                f"    - {report.path}\n"
                f"      files={report.file_count} size≈{_format_bytes(report.approx_bytes)}\n"
                f"      top: {sample}"
            )
        if len(stats.ghost_reports) > 50:
            print(f"    … and {len(stats.ghost_reports) - 50} more")
    if stats.failures:
        print("  failures:")
        for line in stats.failures[:20]:
            print(f"    - {line}")
    if dry_run and (stats.pointers_cleared or stats.ghost_dirs_found):
        print("\nRe-run with --apply to clear pointers and delete ghost directories.")


async def main() -> None:
    args = _parse_args()
    dry_run = not args.apply
    if dry_run:
        print(
            "Dry run — no DB/filesystem changes. "
            "Pass --apply to clear orphan pointers and delete ghost directories."
        )
    stats = await cleanup_auto_desk_orphans(dry_run=dry_run)
    _print_stats(dry_run=dry_run, stats=stats)


if __name__ == "__main__":
    asyncio.run(main())
