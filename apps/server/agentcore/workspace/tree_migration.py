"""存量迁移：把云工作区从「id 命名的平铺目录」搬成「可见名的真目录树」。

两半分开、都可单测：

* :func:`plan_rel_paths` —— 纯函数，给每个既有文件夹算出它在树里的槽位。非法字符按
  和新建同一套规则净化（:mod:`agentcore.workspace.cloud_tree`），重名按「先建的先
  占名，后来的加 ``(2)``」。alembic 用它回填 ``folders.rel_path``。
* :func:`relocate_user_workspaces` —— 按回填好的 rel_path 真正动盘：目录从
  ``<user>/<folder_id>/`` 搬到 ``<user>/tree/<rel_path>/``，三个隐藏 zone 从树内搬到
  ``<user>/internal/<kind>/<id>/``。幂等：已经搬过的再跑一次什么也不做。
* :func:`relocate_deleted_folders` —— 已软删的那些搬去墓碑区而不是树里（名字早已释放，
  树里可能已有活文件夹占着同名），保留期内仍可恢复。

盘上迁移不放进 alembic：DB 事务回滚不了 ``mv``，把两者绑在一个事务里只会制造「DB 已
回滚、文件已经搬走」的坏状态。所以拆成部署链里的一步：alembic 回填 →
``scripts/migrate_workspace_tree.py`` → ``scripts/migrate_project_docs.py``（它读的是
搬迁**之后**的 ``tree/`` 落点），全部在起 api 之前。中途中断重跑即可。

「盘上有哪些用户目录」不在这里判——那是
:mod:`agentcore.workspace.layout` 的单一判据，扫盘的脚本都问它。
"""

from __future__ import annotations

import shutil
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from agentcore.workspace.cloud_tree import sanitize_folder_name, unique_sibling_name
from agentcore.workspace.layout import (
    CONV_SEGMENT,
    DELETED_SEGMENT,
    INTERNAL_SEGMENT,
    TREE_SEGMENT,
)
from agentcore.workspace.stage_dirs import INTERNAL_ZONE_NAMES

AGENTCORE_DIR = "AgentCore"


def plan_rel_paths(folders: Sequence[tuple[str, str]]) -> dict[str, str]:
    """``[(folder_id, name)]`` (oldest first) → ``{folder_id: rel_path}``.

    Every pre-migration folder was flat, so they all land directly under the tree
    root. Order is the caller's: whoever was created first keeps the plain name and
    later collisions get numbered, which makes the result stable across re-runs.
    """
    taken: set[str] = set()
    planned: dict[str, str] = {}
    for folder_id, name in folders:
        slot = unique_sibling_name(sanitize_folder_name(name), taken)
        taken.add(slot)
        planned[folder_id] = slot
    return planned


@dataclass
class RelocationReport:
    """What a data-dir sweep actually did (script prints it; tests assert on it)."""

    folders_moved: int = 0
    zones_moved: int = 0
    skipped_existing: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.skipped_existing is None:
            self.skipped_existing = []


def _move_internal_zones(*, root: Path, internal_root: Path) -> int:
    """Lift ``AgentCore/{index,trash,baselines}`` out of a workspace tree."""
    agentcore_dir = root / AGENTCORE_DIR
    if not agentcore_dir.is_dir():
        return 0
    moved = 0
    for zone in sorted(INTERNAL_ZONE_NAMES):
        src = agentcore_dir / zone
        if not src.is_dir():
            continue
        dest = internal_root / zone
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        moved += 1
    # An AgentCore/ that held nothing but zones is machine litter, not user content.
    if agentcore_dir.is_dir() and not any(agentcore_dir.iterdir()):
        agentcore_dir.rmdir()
    return moved


def relocate_user_workspaces(
    *,
    workspaces_base: Path,
    user_id: str,
    folder_rel_paths: dict[str, str],
    conversation_ids: Iterable[str] = (),
    report: RelocationReport | None = None,
) -> RelocationReport:
    """Move one user's flat folder dirs into ``tree/`` and lift the hidden zones.

    Idempotent by construction: a folder already gone from its flat location is
    skipped, and a destination that already exists is reported rather than merged —
    silently merging two folders' files would be unrecoverable.
    """
    report = report or RelocationReport()
    user_base = workspaces_base / user_id
    if not user_base.is_dir():
        return report

    for folder_id, rel_path in folder_rel_paths.items():
        src = user_base / folder_id
        dest = user_base / TREE_SEGMENT / Path(*rel_path.split("/"))
        internal_root = user_base / INTERNAL_SEGMENT / "folder" / folder_id
        if src.is_dir():
            report.zones_moved += _move_internal_zones(root=src, internal_root=internal_root)
            if dest.exists():
                report.skipped_existing.append(f"{user_id}/{rel_path}")
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dest))
            report.folders_moved += 1
        elif dest.is_dir():
            # Already relocated on an earlier run; zones may still be in-tree.
            report.zones_moved += _move_internal_zones(root=dest, internal_root=internal_root)

    conv_base = user_base / CONV_SEGMENT
    for conversation_id in conversation_ids:
        conv_root = conv_base / conversation_id
        if not conv_root.is_dir():
            continue
        report.zones_moved += _move_internal_zones(
            root=conv_root,
            internal_root=user_base / INTERNAL_SEGMENT / CONV_SEGMENT / conversation_id,
        )
    return report


def relocate_deleted_folders(
    *,
    workspaces_base: Path,
    user_id: str,
    deleted_folder_ids: Iterable[str],
    report: RelocationReport | None = None,
) -> RelocationReport:
    """Park already soft-deleted folders' flat dirs in the tombstone area.

    They must not go into the visible tree: their name was released the moment the
    user deleted them, so a live folder may hold it. Skipping them entirely is not
    an option either — a project still inside the retention window is restorable,
    and restore looks for the directory here.
    """
    report = report or RelocationReport()
    user_base = workspaces_base / user_id
    if not user_base.is_dir():
        return report
    for folder_id in deleted_folder_ids:
        src = user_base / folder_id
        internal_root = user_base / INTERNAL_SEGMENT / "folder" / folder_id
        dest = user_base / DELETED_SEGMENT / folder_id
        if not src.is_dir():
            continue
        report.zones_moved += _move_internal_zones(root=src, internal_root=internal_root)
        if dest.exists():
            report.skipped_existing.append(f"{user_id}/{DELETED_SEGMENT}/{folder_id}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dest))
        report.folders_moved += 1
    return report


def discover_scratch_conversation_ids(*, workspaces_base: Path, user_id: str) -> list[str]:
    """Conversation ids that have a scratch dir on disk (no DB round-trip needed).

    Deliberately disk-driven, not DB-driven: the users who need this most are the
    ones a ``folders`` query cannot see (see the script's user-discovery note).
    """
    conv_base = workspaces_base / user_id / CONV_SEGMENT
    if not conv_base.is_dir():
        return []
    return sorted(p.name for p in conv_base.iterdir() if p.is_dir())


def has_in_tree_zones(root: Path) -> bool:
    """Whether ``root`` still holds hidden zones that this migration would lift."""
    agentcore_dir = root / AGENTCORE_DIR
    return any((agentcore_dir / zone).is_dir() for zone in INTERNAL_ZONE_NAMES)
