"""Backfill: move bare-chat scratch trees into minted auto cloud desks.

After ``Conversation.auto_desk_folder_id`` was introduced, older bare chats could
keep user files under ``workspaces/<user>/conv/<cid>/`` while AI tools wrote to
the auto desk ``workspaces/<user>/<auto_desk>/``. This pass merges remaining
scratch content into the desk (cloud only). Affiliation ``folder_id`` is never
touched.

Run from ``apps/server``::

    # preview (default)
    uv run python scripts/backfill_auto_desk_scratch.py

    # apply moves
    uv run python scripts/backfill_auto_desk_scratch.py --apply
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.models import Conversation
from agentcore.workspace._paths import path_has_non_internal_entries
from agentcore.workspace.locate import workspace_root_path
from agentcore.workspace.migrate_tree import MergeMoveResult, merge_move_tree

logger = get_logger(__name__)

__all__ = [
    "BackfillStats",
    "MergeMoveResult",
    "backfill_auto_desk_scratch",
    "merge_move_tree",
]


@dataclass
class BackfillStats:
    """Outcome counters for a backfill run."""

    conversations_scanned: int = 0
    conversations_moved: int = 0
    conversations_skipped_empty: int = 0
    conversations_failed: int = 0
    files_moved: int = 0
    conflicts: int = 0
    failures: list[str] = field(default_factory=list)


def scratch_and_desk_roots(
    *,
    user_id: str,
    conversation_id: str,
    auto_desk_folder_id: str,
) -> tuple[Path, Path]:
    """Cloud paths for bare-chat scratch and its auto desk (no mkdir)."""
    scratch = workspace_root_path(
        user_id=user_id, folder_id=None, conversation_id=conversation_id
    )
    desk = workspace_root_path(
        user_id=user_id, folder_id=auto_desk_folder_id, conversation_id=conversation_id
    )
    return scratch, desk


def should_backfill_conversation(
    *,
    folder_id: str | None,
    auto_desk_folder_id: str | None,
    scratch: Path,
) -> bool:
    """True when a bare chat has an auto desk and scratch still holds user content."""
    if folder_id:
        return False
    if not (isinstance(auto_desk_folder_id, str) and auto_desk_folder_id.strip()):
        return False
    return path_has_non_internal_entries(scratch)


async def list_auto_desk_bare_conversations() -> list[Conversation]:
    """Cloud bare chats with a persisted ``auto_desk_folder_id`` (affiliation still NULL)."""
    async with async_session_factory() as session:
        rows = (
            await session.execute(
                select(Conversation).where(
                    Conversation.folder_id.is_(None),
                    Conversation.auto_desk_folder_id.is_not(None),
                )
            )
        ).scalars().all()
        return list(rows)


async def backfill_auto_desk_scratch(*, dry_run: bool = True) -> BackfillStats:
    """Move leftover bare-chat scratch trees into their auto desks.

    Per-conversation failures are logged and skipped — one bad tree must not
    abort the rest. ``dry_run=True`` only reports what would move.
    """
    stats = BackfillStats()
    try:
        conversations = await list_auto_desk_bare_conversations()
    except Exception as e:  # noqa: BLE001
        logger.warning("auto_desk.backfill_list_failed", error=str(e))
        stats.failures.append(f"list: {e}")
        stats.conversations_failed += 1
        return stats

    for conv in conversations:
        stats.conversations_scanned += 1
        cid = conv.id
        uid = conv.user_id
        desk_id = (conv.auto_desk_folder_id or "").strip()
        try:
            scratch, desk = scratch_and_desk_roots(
                user_id=uid, conversation_id=cid, auto_desk_folder_id=desk_id
            )
            if not should_backfill_conversation(
                folder_id=conv.folder_id,
                auto_desk_folder_id=desk_id,
                scratch=scratch,
            ):
                stats.conversations_skipped_empty += 1
                continue

            if dry_run:
                stats.conversations_moved += 1
                logger.info(
                    "auto_desk.backfill_would_move",
                    conversation_id=cid,
                    user_id=uid,
                    auto_desk_folder_id=desk_id,
                    scratch=str(scratch),
                    desk=str(desk),
                )
                continue

            move = merge_move_tree(scratch, desk)
            stats.files_moved += move.moved
            stats.conflicts += move.skipped_conflicts
            stats.conversations_moved += 1
            logger.info(
                "auto_desk.backfill_moved",
                conversation_id=cid,
                user_id=uid,
                auto_desk_folder_id=desk_id,
                moved=move.moved,
                conflicts=move.skipped_conflicts,
                skipped_internal=move.skipped_internal,
            )
        except Exception as e:  # noqa: BLE001 — isolate per conversation
            stats.conversations_failed += 1
            stats.failures.append(f"{cid}: {e}")
            logger.warning(
                "auto_desk.backfill_conversation_failed",
                conversation_id=cid,
                error=str(e),
            )

    return stats


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Move bare-chat scratch leftovers into minted auto cloud desks."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform moves (default is dry-run preview only).",
    )
    return parser.parse_args()


def _print_stats(*, dry_run: bool, stats: BackfillStats) -> None:
    mode = "DRY RUN" if dry_run else "APPLIED"
    print(f"\nAuto-desk scratch backfill ({mode})")
    print(f"  data_dir:                       {settings.data_dir}")
    print(f"  conversations scanned:          {stats.conversations_scanned}")
    print(f"  conversations skipped (empty):  {stats.conversations_skipped_empty}")
    print(f"  conversations moved:            {stats.conversations_moved}")
    print(f"  conversations failed:           {stats.conversations_failed}")
    if not dry_run:
        print(f"  entries moved:                  {stats.files_moved}")
        print(f"  conflicts left in scratch:      {stats.conflicts}")
    if stats.failures:
        print("  failures:")
        for line in stats.failures[:20]:
            print(f"    - {line}")
    if dry_run and stats.conversations_moved:
        print("\nRe-run with --apply to perform the moves.")


async def main() -> None:
    args = _parse_args()
    dry_run = not args.apply
    if dry_run:
        print("Dry run — no filesystem changes. Pass --apply to move scratch → desk.")
    stats = await backfill_auto_desk_scratch(dry_run=dry_run)
    _print_stats(dry_run=dry_run, stats=stats)


if __name__ == "__main__":
    asyncio.run(main())
