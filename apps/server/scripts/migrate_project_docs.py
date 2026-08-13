"""Deploy-window ``AgentCore/文档/项目/`` → documents-entry migration (记忆 · 步 3).

Reads each cloud folder workspace once, files every thick dossier as an ``on_demand``
folder-scoped entry, and moves the disk originals to ``AgentCore/文档/已迁入记忆/``.
Idempotent — a second run finds nothing left to do. Details / reach boundary (local-bound
folders are not visible to a server-side pass) → ``agentcore/memory/migrate_project_docs``.

**顺序是硬约束**：停 api → ``alembic upgrade head`` → ``scripts/migrate_workspace_tree.py``
→ **本脚本** → 起 api。本脚本读的是迁移**之后**的 ``tree/<rel_path>/``，跑在树迁移之前
会一个目录都找不到。这是一次性 pass，没人会重跑，所以「一个都没扫到」在这里绝不允许伪装
成成功——见下面两个非零退出码。跑在停-api 窗口内，免得活回合正在往目录里写。

From ``apps/server``::

    uv run python scripts/migrate_project_docs.py

Compose / deploy::

    docker compose run --rm api python scripts/migrate_project_docs.py

退出码：0 成功；1 有文件迁移失败；2 顺序错了（还有文件夹停在旧的平铺目录）；
3 盘上有用户目录、DB 里有云文件夹，却一个工作区目录都没扫到（确认无误可加
``--allow-empty`` 放行）。
"""

from __future__ import annotations

import argparse
import asyncio
import sys


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Import thick folder dossiers into memory entries (deploy window). "
            "Run after scripts/migrate_workspace_tree.py."
        )
    )
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help=(
            "Accept a sweep that scanned zero workspace directories. Only for the case "
            "where the folders genuinely never materialized a directory on disk."
        ),
    )
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> int:
    from agentcore.memory.migrate_project_docs import migrate_all_project_docs

    stats = await migrate_all_project_docs()
    print(
        "project-docs:"
        f" folders={stats.folders_considered}"
        f" users_on_disk={stats.users_on_disk}"
        f" workspaces={stats.workspaces_scanned}"
        f" with_dossiers={stats.workspaces_with_dossiers}"
        f" imported={stats.entries_imported}"
        f" already_present={stats.entries_already_present}"
        f" archived={stats.files_archived}"
        f" failed={stats.files_failed}"
    )
    if stats.folders_pending_tree_migration:
        print(
            f"ERROR: {stats.folders_pending_tree_migration} 个文件夹仍停在旧的平铺目录 "
            "workspaces/<user>/<folder_id>/ —— 本脚本只认迁移后的 tree/<rel_path>/。"
            "先跑 scripts/migrate_workspace_tree.py，再重跑本脚本（幂等）。",
            file=sys.stderr,
        )
        return 2
    swept_nothing = bool(
        stats.folders_considered and stats.users_on_disk and not stats.workspaces_scanned
    )
    if swept_nothing and not args.allow_empty:
        print(
            f"ERROR: DB 里有 {stats.folders_considered} 个云文件夹、盘上有 "
            f"{stats.users_on_disk} 个用户目录，却一个工作区目录都没扫到。多半是本脚本跑在了 "
            "scripts/migrate_workspace_tree.py 之前——一次性 pass 静默成功就再没人会重跑。"
            "确认顺序无误、这些文件夹本来就没落过盘，再加 --allow-empty。",
            file=sys.stderr,
        )
        return 3
    return 1 if stats.files_failed else 0


def main() -> None:
    # Process-wide logging belongs to the entry point, not to ``_run``: the exit-code
    # tests call ``_run`` directly, and ``setup_logging`` re-points structlog for the
    # whole pytest session (stdlib pipeline at LOG_LEVEL), silencing later tests' lines.
    from agentcore.core.logging import setup_logging

    args = _parse_args()
    setup_logging()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
