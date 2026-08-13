"""把存量云工作区目录搬到可见名的真目录树（双模式工作区 §5.4 的盘上那一半）。

**部署链里的位置是硬约束**：停 api → ``alembic upgrade head``（回填 ``folders.rel_path``）
→ **本脚本** → ``scripts/migrate_project_docs.py`` → 起 api。

必须跑在 api 起来之前：``resolve_workspace_root`` 是无条件 ``mkdir`` 的，升级后第一个
打开云文件夹的用户会当场把迁移目标建成一个空目录；而本脚本「目标已存在就跳过、绝不
合并」，运维事后补跑只会被判 skipped，文件就永久留在旧的平铺目录里了。

手动跑（从 ``apps/server``）::

    uv run python scripts/migrate_workspace_tree.py --dry-run
    uv run python scripts/migrate_workspace_tree.py

做两件事，都幂等，中断后重跑即可：

1. ``workspaces/<user>/<folder_id>/`` → ``workspaces/<user>/tree/<rel_path>/``
2. 树内 ``AgentCore/{index,trash,baselines}`` → ``workspaces/<user>/internal/…``
   （文件夹与裸聊 scratch 都处理）

目的地已存在时**跳过并报告**，绝不合并——两个文件夹的文件混进一个目录是不可逆的。
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

import sqlalchemy as sa

from agentcore.db.base import async_session_factory
from agentcore.workspace.layout import (
    CONV_SEGMENT,
    discover_user_ids,
    workspaces_base_path,
)
from agentcore.workspace.tree_migration import (
    RelocationReport,
    discover_scratch_conversation_ids,
    has_in_tree_zones,
    relocate_deleted_folders,
    relocate_user_workspaces,
)


async def _load_placements() -> tuple[dict[str, dict[str, str]], dict[str, list[str]], int]:
    """``({user: {folder_id: rel_path}}, {user: [deleted folder ids]}, 未回填行数)``.

    The two placements go to different places on disk: live folders into the visible
    tree, soft-deleted ones into the tombstone area. The third value is the
    "alembic did not run" tripwire — a deployment with no folders at all is
    legitimately empty, so an empty result cannot stand in for it.
    """
    async with async_session_factory() as session:
        rows = await session.execute(
            sa.text("SELECT id, user_id, rel_path, deleted_at FROM folders")
        )
        live: dict[str, dict[str, str]] = {}
        deleted: dict[str, list[str]] = {}
        unplaced = 0
        for folder_id, user_id, rel_path, deleted_at in rows.all():
            if rel_path is None:
                unplaced += 1
            elif deleted_at is None:
                live.setdefault(str(user_id), {})[str(folder_id)] = str(rel_path)
            else:
                deleted.setdefault(str(user_id), []).append(str(folder_id))
        return live, deleted, unplaced


def sweep_user_ids(
    *,
    workspaces_base: Path,
    by_user: dict[str, dict[str, str]],
    deleted_by_user: dict[str, list[str]],
) -> list[str]:
    """要扫的用户 = ``folders`` 里有行的 ∪ 盘上真实存在的用户目录。

    只信 DB 会整类漏掉**从没建过文件夹的纯裸聊用户**：他们在 ``folders`` 里一行都没有，
    却在 ``conv/<cid>/AgentCore/trash`` 里躺着自己删掉的文件。索引丢了能自愈，回收区和
    基线不能——不扫他们就等于升级当天替他们清空了回收站。
    """
    return sorted(set(by_user) | set(deleted_by_user) | set(discover_user_ids(workspaces_base)))


def _describe(base: Path, user_id: str, placements: dict[str, str]) -> list[str]:
    lines = []
    user_base = base / user_id
    for folder_id, rel_path in sorted(placements.items(), key=lambda kv: kv[1]):
        if (user_base / folder_id).is_dir():
            lines.append(f"  {folder_id}  ->  tree/{rel_path}")
    return lines


def _describe_pending_zones(base: Path, user_id: str) -> list[str]:
    """裸聊 scratch 里还没搬出的隐藏 zone（dry-run 让纯裸聊用户也看得见）。"""
    conv_base = base / user_id / CONV_SEGMENT
    return [
        f"  conv/{cid}/AgentCore/*  ->  internal/conv/{cid}/"
        for cid in discover_scratch_conversation_ids(workspaces_base=base, user_id=user_id)
        if has_in_tree_zones(conv_base / cid)
    ]


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true", help="只打印将要执行的搬迁，不动盘"
    )
    args = parser.parse_args()

    base = workspaces_base_path()
    if not base.is_dir():
        print(f"没有 workspaces 目录，无需迁移：{base}")
        return 0

    by_user, deleted_by_user, unplaced = await _load_placements()
    if unplaced:
        print(
            f"还有 {unplaced} 个文件夹的 rel_path 为空 —— "
            "先跑 alembic upgrade head（a1f7c3e9b2d5 回填）再执行本脚本。"
        )
        return 1

    users = sweep_user_ids(
        workspaces_base=base, by_user=by_user, deleted_by_user=deleted_by_user
    )

    if args.dry_run:
        for user_id in users:
            lines = _describe(base, user_id, by_user.get(user_id, {}))
            lines += _describe_pending_zones(base, user_id)
            parked = [
                f for f in deleted_by_user.get(user_id, []) if (base / user_id / f).is_dir()
            ]
            if parked:
                lines.append(f"  已软删 {len(parked)} 个  ->  deleted/<folder_id>/")
            if lines:
                print(f"{user_id}:")
                print("\n".join(lines))
        print("\n(dry-run，未改动任何文件)")
        return 0

    report = RelocationReport()
    for user_id in users:
        relocate_user_workspaces(
            workspaces_base=base,
            user_id=user_id,
            folder_rel_paths=by_user.get(user_id, {}),
            conversation_ids=discover_scratch_conversation_ids(
                workspaces_base=base, user_id=user_id
            ),
            report=report,
        )
        deleted_folder_ids = deleted_by_user.get(user_id)
        if deleted_folder_ids:
            relocate_deleted_folders(
                workspaces_base=base,
                user_id=user_id,
                deleted_folder_ids=deleted_folder_ids,
                report=report,
            )

    print(
        f"扫了 {len(users)} 个用户目录，"
        f"已搬迁文件夹目录 {report.folders_moved} 个，隐藏 zone {report.zones_moved} 个。"
    )
    if report.skipped_existing:
        print("\n以下目标目录已存在，已跳过（请人工确认后处理）：")
        for item in report.skipped_existing:
            print(f"  {item}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
