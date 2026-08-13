"""存量迁移：id 命名的平铺目录 → 可见名的真目录树（双模式工作区 §5.4）。

两半分开测，因为它们的失败方式不同：``plan_rel_paths`` 错了会让两个文件夹分到同一
个槽位（DB 层的唯一索引会拒，迁移当场失败）；``relocate_user_workspaces`` 错了会把
文件搬丢或把两个文件夹的内容混进一个目录，那是不可逆的。
"""

from pathlib import Path

from agentcore.workspace.tree_migration import (
    discover_scratch_conversation_ids,
    has_in_tree_zones,
    plan_rel_paths,
    relocate_deleted_folders,
    relocate_user_workspaces,
)


def test_illegal_characters_are_replaced_in_the_planned_slot():
    planned = plan_rel_paths([("f1", "报告 2025/Q1"), ("f2", 'a:b*c?d')])
    assert planned["f1"] == "报告 2025_Q1"
    assert planned["f2"] == "a_b_c_d"


def test_duplicate_names_get_numbered_oldest_first():
    """先建的保留原名——迁移前用户看到的顺序不变。"""
    planned = plan_rel_paths([("old", "报告"), ("mid", "报告"), ("new", "报告")])
    assert planned == {"old": "报告", "mid": "报告 (2)", "new": "报告 (3)"}


def test_duplicates_that_only_differ_by_case_still_collide():
    planned = plan_rel_paths([("f1", "Report"), ("f2", "report")])
    assert planned["f2"] != planned["f1"]


def test_a_name_that_sanitizes_to_nothing_still_gets_a_unique_slot():
    planned = plan_rel_paths([("f1", "..."), ("f2", "  ")])
    assert len(set(planned.values())) == 2


def _flat_folder(base: Path, user: str, folder_id: str) -> Path:
    root = base / user / folder_id
    (root / "文档").mkdir(parents=True)
    (root / "文档" / "note.md").write_text("hi\n", encoding="utf-8")
    return root


def test_relocation_moves_folders_under_tree_and_lifts_hidden_zones(tmp_path: Path):
    base = tmp_path / "workspaces"
    user = "u1"
    root = _flat_folder(base, user, "f1")
    (root / "AgentCore" / "index").mkdir(parents=True)
    (root / "AgentCore" / "index" / "code_search.db").write_bytes(b"db")
    (root / "AgentCore" / "trash").mkdir(parents=True)
    (root / "AgentCore" / "文档").mkdir(parents=True)
    (root / "AgentCore" / "文档" / "out.md").write_text("ai\n", encoding="utf-8")

    report = relocate_user_workspaces(
        workspaces_base=base, user_id=user, folder_rel_paths={"f1": "报告"}
    )

    dest = base / user / "tree" / "报告"
    assert report.folders_moved == 1
    assert (dest / "文档" / "note.md").read_text(encoding="utf-8") == "hi\n"
    # 可见的 AgentCore/文档 跟着工作区根走，隐藏 zone 搬出用户树。
    assert (dest / "AgentCore" / "文档" / "out.md").is_file()
    assert not (dest / "AgentCore" / "index").exists()
    internal = base / user / "internal" / "folder" / "f1"
    assert (internal / "index" / "code_search.db").read_bytes() == b"db"
    assert (internal / "trash").is_dir()
    assert not (base / user / "f1").exists()


def test_relocation_is_idempotent(tmp_path: Path):
    base = tmp_path / "workspaces"
    _flat_folder(base, "u1", "f1")

    first = relocate_user_workspaces(
        workspaces_base=base, user_id="u1", folder_rel_paths={"f1": "报告"}
    )
    second = relocate_user_workspaces(
        workspaces_base=base, user_id="u1", folder_rel_paths={"f1": "报告"}
    )

    assert first.folders_moved == 1
    assert second.folders_moved == 0
    assert (base / "u1" / "tree" / "报告" / "文档" / "note.md").is_file()


def test_an_occupied_destination_is_reported_never_merged(tmp_path: Path):
    """两个文件夹的文件混进一个目录是不可逆的，宁可停下来让人处理。"""
    base = tmp_path / "workspaces"
    _flat_folder(base, "u1", "f1")
    occupied = base / "u1" / "tree" / "报告"
    occupied.mkdir(parents=True)
    (occupied / "别人的.txt").write_text("x", encoding="utf-8")

    report = relocate_user_workspaces(
        workspaces_base=base, user_id="u1", folder_rel_paths={"f1": "报告"}
    )

    assert report.folders_moved == 0
    assert report.skipped_existing == ["u1/报告"]
    assert (base / "u1" / "f1" / "文档" / "note.md").is_file()


def test_scratch_zones_are_lifted_too(tmp_path: Path):
    base = tmp_path / "workspaces"
    conv_root = base / "u1" / "conv" / "c1"
    (conv_root / "AgentCore" / "baselines").mkdir(parents=True)
    (conv_root / "AgentCore" / "baselines" / "b.zip").write_bytes(b"z")

    report = relocate_user_workspaces(
        workspaces_base=base,
        user_id="u1",
        folder_rel_paths={},
        conversation_ids=discover_scratch_conversation_ids(
            workspaces_base=base, user_id="u1"
        ),
    )

    assert report.zones_moved == 1
    assert (base / "u1" / "internal" / "conv" / "c1" / "baselines" / "b.zip").is_file()
    # scratch 目录本身不动——它本来就在用户树之外。
    assert conv_root.is_dir()


def test_already_soft_deleted_folders_go_to_the_tombstone_not_the_tree(tmp_path: Path):
    """软删的存量目录不能进树：名字早已释放，树里可能已有活文件夹占着同名。"""
    base = tmp_path / "workspaces"
    _flat_folder(base, "u1", "gone")
    (base / "u1" / "gone" / "AgentCore" / "trash").mkdir(parents=True)
    _flat_folder(base, "u1", "live")

    report = relocate_user_workspaces(
        workspaces_base=base, user_id="u1", folder_rel_paths={"live": "报告"}
    )
    relocate_deleted_folders(
        workspaces_base=base, user_id="u1", deleted_folder_ids=["gone"], report=report
    )

    assert (base / "u1" / "tree" / "报告" / "文档" / "note.md").is_file()
    tomb = base / "u1" / "deleted" / "gone"
    assert (tomb / "文档" / "note.md").is_file()
    assert not (tomb / "AgentCore" / "trash").exists()
    assert (base / "u1" / "internal" / "folder" / "gone" / "trash").is_dir()
    assert not (base / "u1" / "gone").exists()


def test_tombstone_relocation_is_idempotent(tmp_path: Path):
    base = tmp_path / "workspaces"
    _flat_folder(base, "u1", "gone")

    first = relocate_deleted_folders(
        workspaces_base=base, user_id="u1", deleted_folder_ids=["gone"]
    )
    second = relocate_deleted_folders(
        workspaces_base=base, user_id="u1", deleted_folder_ids=["gone"]
    )

    assert (first.folders_moved, second.folders_moved) == (1, 0)
    assert (base / "u1" / "deleted" / "gone" / "文档" / "note.md").is_file()


def test_pending_zones_are_visible_before_and_gone_after_a_sweep(tmp_path: Path):
    """dry-run 靠这个判断「这个用户还有活要干」——尤其是 DB 里看不见的纯裸聊用户。"""
    base = tmp_path / "workspaces"
    conv_root = base / "u1" / "conv" / "c1"
    (conv_root / "AgentCore" / "trash").mkdir(parents=True)

    assert has_in_tree_zones(conv_root)

    relocate_user_workspaces(
        workspaces_base=base,
        user_id="u1",
        folder_rel_paths={},
        conversation_ids=["c1"],
    )

    assert not has_in_tree_zones(conv_root)
