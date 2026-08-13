"""步 3 存量迁移：``AgentCore/文档/项目/`` → 按需主题条目，原件归档。"""

from __future__ import annotations

import argparse
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import scripts.migrate_project_docs as script
from agentcore.config import settings
from agentcore.memory.migrate_project_docs import (
    LEGACY_PROJECT_DOCS_DIR_NAME,
    MIGRATED_DOCS_DIR_NAME,
    ProjectDocsMigrationStats,
    migrate_all_project_docs,
    migrate_workspace_project_docs,
)
from agentcore.memory.store import FileMemoryStore

_UID = "11111111-1111-4111-8111-111111111111"
_FID = "22222222-2222-4222-8222-222222222222"


def _docs_root(root: Path) -> Path:
    return root / "AgentCore" / "文档"


def _legacy_dir(root: Path) -> Path:
    return _docs_root(root) / LEGACY_PROJECT_DOCS_DIR_NAME


def _archive_dir(root: Path) -> Path:
    return _docs_root(root) / MIGRATED_DOCS_DIR_NAME


def _write_dossier(root: Path, rel: str, body: str | bytes) -> Path:
    path = _legacy_dir(root) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(body, bytes):
        path.write_bytes(body)
    else:
        path.write_text(body, encoding="utf-8")
    return path


def _stores(tmp_path: Path) -> tuple[Path, FileMemoryStore]:
    """(workspace root, memory store) on separate trees, as in production."""
    return tmp_path / "ws", FileMemoryStore(tmp_path / "memory")


async def _run(root: Path, store: FileMemoryStore):
    return await migrate_workspace_project_docs(
        root, user_id=_UID, folder_id=_FID, store=store
    )


async def test_md_becomes_on_demand_topic_entry_and_original_is_archived(tmp_path: Path):
    root, store = _stores(tmp_path)
    _write_dossier(root, "架构详解.md", "# 架构\n长篇背景资料\n")

    stats = await _run(root, store)

    assert (stats.workspaces_scanned, stats.workspaces_with_dossiers) == (1, 1)
    assert (stats.entries_imported, stats.files_archived, stats.files_failed) == (1, 1, 0)
    entry = await store.load(_UID, "主题/架构详解.md", _FID)
    assert "apply: on_demand" in entry
    assert "长篇背景资料" in entry
    # 作用域挂原文件夹：全局层不得长出同名条目。
    assert await store.load(_UID, "主题/架构详解.md") == ""
    # 目录消失，原件原样留在一眼可辨的归档位。
    assert not _legacy_dir(root).exists()
    assert (
        _archive_dir(root) / "架构详解.md"
    ).read_text(encoding="utf-8") == "# 架构\n长篇背景资料\n"


async def test_empty_dir_disappears_without_writing_entries(tmp_path: Path):
    root, store = _stores(tmp_path)
    (_legacy_dir(root) / "空子目录").mkdir(parents=True)

    stats = await _run(root, store)

    assert (stats.workspaces_with_dossiers, stats.entries_imported) == (1, 0)
    assert stats.files_archived == 0
    assert not _legacy_dir(root).exists()
    assert await store.list(_UID, _FID) == []
    assert not _archive_dir(root).exists()


async def test_missing_dir_is_a_no_op(tmp_path: Path):
    root, store = _stores(tmp_path)
    root.mkdir(parents=True)

    stats = await _run(root, store)

    assert (stats.workspaces_scanned, stats.workspaces_with_dossiers) == (1, 0)
    assert stats.files_archived == 0


async def test_name_conflict_keeps_the_existing_entry_and_suffixes(tmp_path: Path):
    root, store = _stores(tmp_path)
    await store.save(_UID, "主题/架构详解.md", "已有主题笔记\n", _FID)
    _write_dossier(root, "架构详解.md", "厚约定文档正文\n")

    stats = await _run(root, store)

    assert stats.entries_imported == 1
    assert await store.load(_UID, "主题/架构详解.md", _FID) == "已有主题笔记\n"
    assert "厚约定文档正文" in await store.load(_UID, "主题/架构详解-2.md", _FID)


async def test_non_md_file_is_archived_but_never_imported(tmp_path: Path):
    root, store = _stores(tmp_path)
    _write_dossier(root, "图纸.png", b"\x89PNG\r\n\x1a\n binary")

    stats = await _run(root, store)

    assert (stats.entries_imported, stats.files_archived, stats.files_failed) == (0, 1, 0)
    assert await store.list(_UID, _FID) == []
    assert (_archive_dir(root) / "图纸.png").is_file()
    assert not _legacy_dir(root).exists()


async def test_nested_dossier_flattens_into_one_slug(tmp_path: Path):
    root, store = _stores(tmp_path)
    _write_dossier(root, "深/层/案.md", "嵌套厚文档\n")

    stats = await _run(root, store)

    assert stats.entries_imported == 1
    assert "嵌套厚文档" in await store.load(_UID, "主题/深_层_案.md", _FID)
    # 归档保留原目录结构，便于用户认回原件。
    assert (_archive_dir(root) / "深" / "层" / "案.md").is_file()


async def test_rerun_after_a_failed_archive_does_not_fork_a_duplicate(tmp_path: Path):
    """条目已写、原件没搬走的半程失败重跑：认出是同一份，不再造 ``-2``。"""
    root, store = _stores(tmp_path)
    body = "# 架构\n长篇背景资料\n"
    _write_dossier(root, "架构详解.md", body)
    await _run(root, store)
    _write_dossier(root, "架构详解.md", body)

    stats = await _run(root, store)

    assert (stats.entries_imported, stats.entries_already_present) == (0, 1)
    assert stats.files_archived == 1
    assert [m.path for m in await store.list(_UID, _FID)] == ["主题/架构详解.md"]
    assert (_archive_dir(root) / "架构详解-2.md").is_file()


async def test_second_run_on_a_clean_tree_changes_nothing(tmp_path: Path):
    root, store = _stores(tmp_path)
    _write_dossier(root, "架构详解.md", "厚文档\n")
    await _run(root, store)
    before = [m.path for m in await store.list(_UID, _FID)]

    stats = await _run(root, store)

    assert (stats.workspaces_with_dossiers, stats.entries_imported) == (0, 0)
    assert [m.path for m in await store.list(_UID, _FID)] == before


# --- 顺序：本 pass 读的是 tree 迁移**之后**的落点 -----------------------------------
#
# 跑在 scripts/migrate_workspace_tree.py 之前，每个文件夹都会 continue 掉，打印一行
# 全零、退出码 0 —— 而这是一次性 pass，看起来完美成功就再没人会重跑，厚文档永远留在盘上。


class _FakeSession:
    """够 ``migrate_all_project_docs`` 那一句 ``select`` 用的最小替身。"""

    def __init__(self, rows: list[tuple[str, str, str]]) -> None:
        self._rows = rows

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_exc: object) -> bool:
        return False

    async def execute(self, *_args: object, **_kwargs: object) -> SimpleNamespace:
        return SimpleNamespace(all=lambda: list(self._rows))


def _rows_factory(rows: list[tuple[str, str, str]]):
    return lambda: _FakeSession(rows)


async def test_a_folder_still_in_the_flat_layout_is_counted_not_silently_skipped(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    (tmp_path / "workspaces" / _UID / _FID).mkdir(parents=True)

    stats = await migrate_all_project_docs(
        session_factory=_rows_factory([(_FID, _UID, "报告")]),
        store=FileMemoryStore(tmp_path / "memory"),
    )

    assert stats.folders_pending_tree_migration == 1
    assert (stats.folders_considered, stats.workspaces_scanned) == (1, 0)


async def test_a_relocated_folder_reports_no_pending_migration(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    (tmp_path / "workspaces" / _UID / "tree" / "报告").mkdir(parents=True)

    stats = await migrate_all_project_docs(
        session_factory=_rows_factory([(_FID, _UID, "报告")]),
        store=FileMemoryStore(tmp_path / "memory"),
    )

    assert stats.folders_pending_tree_migration == 0
    assert (stats.workspaces_scanned, stats.users_on_disk) == (1, 1)


async def _exit_code(stats: ProjectDocsMigrationStats, *, allow_empty: bool = False) -> int:
    with patch(
        "agentcore.memory.migrate_project_docs.migrate_all_project_docs",
        new=AsyncMock(return_value=stats),
    ):
        return await script._run(argparse.Namespace(allow_empty=allow_empty))


async def test_the_script_fails_when_folders_are_still_in_the_flat_layout():
    code = await _exit_code(
        ProjectDocsMigrationStats(
            folders_considered=3, folders_pending_tree_migration=3, users_on_disk=1
        )
    )
    assert code == 2


async def test_a_sweep_that_found_nothing_does_not_pass_as_success():
    code = await _exit_code(
        ProjectDocsMigrationStats(folders_considered=3, users_on_disk=2, workspaces_scanned=0)
    )
    assert code == 3


async def test_allow_empty_is_the_documented_way_past_that_alarm():
    code = await _exit_code(
        ProjectDocsMigrationStats(folders_considered=3, users_on_disk=2, workspaces_scanned=0),
        allow_empty=True,
    )
    assert code == 0


async def test_a_deployment_that_never_wrote_anything_is_not_an_alarm():
    """盘上一个用户目录都没有 = 本来就没东西可扫，不该拦下部署。"""
    code = await _exit_code(
        ProjectDocsMigrationStats(folders_considered=3, users_on_disk=0, workspaces_scanned=0)
    )
    assert code == 0


async def test_a_real_sweep_still_reports_success():
    code = await _exit_code(
        ProjectDocsMigrationStats(
            folders_considered=2, users_on_disk=1, workspaces_scanned=2, entries_imported=5
        )
    )
    assert code == 0
