"""部署链里的 ``scripts/migrate_workspace_tree.py``：扫谁、什么时候拒跑。

搬迁本身在 ``test_workspace_tree_migration`` 里测；这里只测脚本自己的两个判断——
**扫描面**和**前置条件**，因为它们错了不会报错，只会安静地少搬一批人。
"""

import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import scripts.migrate_workspace_tree as script
from agentcore.config import settings

_TRASHED = "误删的方案.md"


def _bare_chat_trash(base: Path, user_id: str, conversation_id: str) -> Path:
    """一个纯裸聊用户的回收区：DB 的 folders 表里他一行都没有。"""
    trash = base / "workspaces" / user_id / "conv" / conversation_id / "AgentCore" / "trash"
    trash.mkdir(parents=True)
    (trash / _TRASHED).write_text("keep", encoding="utf-8")
    return trash


def test_the_sweep_set_unions_db_users_with_whoever_is_on_disk(tmp_path: Path):
    on_disk_only = str(uuid4())
    with_folders = str(uuid4())
    with_tombstones = str(uuid4())
    base = tmp_path / "workspaces"
    (base / on_disk_only).mkdir(parents=True)
    (base / "im" / str(uuid4())).mkdir(parents=True)

    users = script.sweep_user_ids(
        workspaces_base=base,
        by_user={with_folders: {str(uuid4()): "报告"}},
        deleted_by_user={with_tombstones: [str(uuid4())]},
    )

    assert users == sorted({on_disk_only, with_folders, with_tombstones})


async def test_a_user_with_no_folder_rows_still_gets_his_scratch_zones_lifted(
    tmp_path: Path, monkeypatch
):
    """纯裸聊老用户在 ``folders`` 里一行都没有，只信 DB 就等于替他清空了回收站。

    索引丢了能自愈，回收区和基线不能——搬不过去就是当场删除用户自己删掉的文件。
    """
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["migrate_workspace_tree.py"])
    user_id = str(uuid4())
    conversation_id = str(uuid4())
    _bare_chat_trash(tmp_path, user_id, conversation_id)

    with patch.object(script, "_load_placements", new=AsyncMock(return_value=({}, {}, 0))):
        code = await script.main()

    assert code == 0
    moved = (
        tmp_path
        / "workspaces"
        / user_id
        / "internal"
        / "conv"
        / conversation_id
        / "trash"
        / _TRASHED
    )
    assert moved.read_text(encoding="utf-8") == "keep"


async def test_dry_run_lists_the_bare_chat_user_without_moving_anything(
    tmp_path: Path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["migrate_workspace_tree.py", "--dry-run"])
    user_id = str(uuid4())
    conversation_id = str(uuid4())
    trash = _bare_chat_trash(tmp_path, user_id, conversation_id)

    with patch.object(script, "_load_placements", new=AsyncMock(return_value=({}, {}, 0))):
        code = await script.main()

    out = capsys.readouterr().out
    assert code == 0
    assert user_id in out
    assert f"conv/{conversation_id}" in out
    assert (trash / _TRASHED).is_file()


async def test_an_unbackfilled_rel_path_stops_the_run(tmp_path: Path, monkeypatch, capsys):
    """rel_path 还是空 = alembic 没跑；照搬只会把目录搬到 ``tree/None``。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["migrate_workspace_tree.py"])
    (tmp_path / "workspaces" / str(uuid4())).mkdir(parents=True)

    with patch.object(script, "_load_placements", new=AsyncMock(return_value=({}, {}, 3))):
        code = await script.main()

    assert code == 1
    assert "alembic" in capsys.readouterr().out


async def test_a_deployment_with_no_folders_at_all_is_not_mistaken_for_a_missed_backfill(
    tmp_path: Path, monkeypatch
):
    """一个文件夹都没有 ≠ 没跑 alembic —— 老判据把这两者混为一谈，会拦下纯裸聊部署。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["migrate_workspace_tree.py"])
    user_id = str(uuid4())
    conversation_id = str(uuid4())
    _bare_chat_trash(tmp_path, user_id, conversation_id)

    with patch.object(script, "_load_placements", new=AsyncMock(return_value=({}, {}, 0))):
        code = await script.main()

    assert code == 0


async def test_an_occupied_destination_fails_the_deploy_step(tmp_path: Path, monkeypatch):
    """目标被占 = 有人已经把空目录建出来了，必须停下来让人看，不能悄悄跳过。"""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(sys, "argv", ["migrate_workspace_tree.py"])
    user_id = str(uuid4())
    folder_id = str(uuid4())
    flat = tmp_path / "workspaces" / user_id / folder_id
    flat.mkdir(parents=True)
    (flat / "note.md").write_text("mine", encoding="utf-8")
    (tmp_path / "workspaces" / user_id / "tree" / "报告").mkdir(parents=True)

    with patch.object(
        script,
        "_load_placements",
        new=AsyncMock(return_value=({user_id: {folder_id: "报告"}}, {}, 0)),
    ):
        code = await script.main()

    assert code == 2
    assert (flat / "note.md").is_file()
