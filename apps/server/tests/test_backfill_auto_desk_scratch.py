"""Tests for scripts/backfill_auto_desk_scratch.py (dry-run + apply)."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from agentcore.config import settings
from scripts.backfill_auto_desk_scratch import (
    backfill_auto_desk_scratch,
    merge_move_tree,
    should_backfill_conversation,
)


@pytest.fixture(autouse=True)
def _redirect_data_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))


def test_merge_move_tree_moves_attachments_into_desk(tmp_path: Path):
    scratch = tmp_path / "scratch"
    desk = tmp_path / "desk"
    (scratch / "attachments").mkdir(parents=True)
    (scratch / "attachments" / "合同.pdf").write_bytes(b"pdf")
    (desk / "AgentCore" / "文档").mkdir(parents=True)
    (desk / "AgentCore" / "文档" / "out.md").write_text("ai\n", encoding="utf-8")

    result = merge_move_tree(scratch, desk)

    assert result.moved >= 1
    assert (desk / "attachments" / "合同.pdf").read_bytes() == b"pdf"
    assert (desk / "AgentCore" / "文档" / "out.md").read_text(encoding="utf-8") == "ai\n"
    assert not (scratch / "attachments").exists()


def test_merge_move_tree_skips_name_conflict(tmp_path: Path):
    scratch = tmp_path / "scratch"
    desk = tmp_path / "desk"
    scratch.mkdir()
    desk.mkdir()
    (scratch / "same.txt").write_text("scratch", encoding="utf-8")
    (desk / "same.txt").write_text("desk", encoding="utf-8")

    result = merge_move_tree(scratch, desk)

    assert result.skipped_conflicts == 1
    assert (desk / "same.txt").read_text(encoding="utf-8") == "desk"
    assert (scratch / "same.txt").read_text(encoding="utf-8") == "scratch"


def test_merge_move_tree_skips_internal_zones(tmp_path: Path):
    scratch = tmp_path / "scratch"
    desk = tmp_path / "desk"
    (scratch / "AgentCore" / "index").mkdir(parents=True)
    (scratch / "AgentCore" / "index" / "x.db").write_bytes(b"db")
    (scratch / "AgentCore" / "文档").mkdir(parents=True)
    (scratch / "AgentCore" / "文档" / "note.md").write_text("n\n", encoding="utf-8")

    result = merge_move_tree(scratch, desk)

    assert (desk / "AgentCore" / "文档" / "note.md").is_file()
    assert not (desk / "AgentCore" / "index").exists()
    assert (scratch / "AgentCore" / "index" / "x.db").is_file()
    assert result.skipped_internal >= 1


def test_merge_move_tree_idempotent(tmp_path: Path):
    scratch = tmp_path / "scratch"
    desk = tmp_path / "desk"
    (scratch / "a.txt").parent.mkdir(parents=True, exist_ok=True)
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / "a.txt").write_text("1", encoding="utf-8")

    first = merge_move_tree(scratch, desk)
    second = merge_move_tree(scratch, desk)

    assert first.moved == 1
    assert second.moved == 0
    assert (desk / "a.txt").read_text(encoding="utf-8") == "1"


def test_should_backfill_requires_auto_desk_and_scratch_content(tmp_path: Path):
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    (scratch / "f.txt").write_text("x", encoding="utf-8")

    assert should_backfill_conversation(
        folder_id=None, auto_desk_folder_id="desk", scratch=scratch
    )
    assert not should_backfill_conversation(
        folder_id="birth", auto_desk_folder_id="desk", scratch=scratch
    )
    assert not should_backfill_conversation(
        folder_id=None, auto_desk_folder_id=None, scratch=scratch
    )
    empty = tmp_path / "empty"
    empty.mkdir()
    assert not should_backfill_conversation(
        folder_id=None, auto_desk_folder_id="desk", scratch=empty
    )


@pytest.mark.asyncio
async def test_backfill_dry_run_does_not_move(tmp_path: Path):
    user_id = "u-dry"
    cid = "c-dry"
    desk_id = "d-dry"
    scratch = tmp_path / "workspaces" / user_id / "conv" / cid
    desk = tmp_path / "workspaces" / user_id / desk_id
    scratch.mkdir(parents=True)
    (scratch / "att.txt").write_text("keep", encoding="utf-8")
    desk.mkdir(parents=True)

    conv = SimpleNamespace(
        id=cid, user_id=user_id, folder_id=None, auto_desk_folder_id=desk_id
    )
    with patch(
        "scripts.backfill_auto_desk_scratch.list_auto_desk_bare_conversations",
        new=AsyncMock(return_value=[conv]),
    ):
        stats = await backfill_auto_desk_scratch(dry_run=True)

    assert stats.conversations_scanned == 1
    assert stats.conversations_moved == 1
    assert (scratch / "att.txt").is_file()
    assert not (desk / "att.txt").exists()


@pytest.mark.asyncio
async def test_backfill_apply_moves_and_is_idempotent(tmp_path: Path):
    user_id = "u-apply"
    cid = "c-apply"
    desk_id = "d-apply"
    scratch = tmp_path / "workspaces" / user_id / "conv" / cid
    desk = tmp_path / "workspaces" / user_id / desk_id
    scratch.mkdir(parents=True)
    (scratch / "att.txt").write_text("keep", encoding="utf-8")
    desk.mkdir(parents=True)

    conv = SimpleNamespace(
        id=cid, user_id=user_id, folder_id=None, auto_desk_folder_id=desk_id
    )
    with patch(
        "scripts.backfill_auto_desk_scratch.list_auto_desk_bare_conversations",
        new=AsyncMock(return_value=[conv]),
    ):
        first = await backfill_auto_desk_scratch(dry_run=False)
        second = await backfill_auto_desk_scratch(dry_run=False)

    assert first.conversations_moved == 1
    assert first.files_moved >= 1
    assert (desk / "att.txt").read_text(encoding="utf-8") == "keep"
    assert not (scratch / "att.txt").exists()
    assert second.conversations_skipped_empty == 1
    assert second.conversations_moved == 0


@pytest.mark.asyncio
async def test_backfill_one_failure_does_not_stop_others(tmp_path: Path):
    good = SimpleNamespace(
        id="c-good", user_id="u1", folder_id=None, auto_desk_folder_id="d1"
    )
    bad = SimpleNamespace(
        id="c-bad", user_id="u1", folder_id=None, auto_desk_folder_id="d2"
    )
    scratch_good = tmp_path / "workspaces" / "u1" / "conv" / "c-good"
    scratch_good.mkdir(parents=True)
    (scratch_good / "ok.txt").write_text("ok", encoding="utf-8")
    (tmp_path / "workspaces" / "u1" / "d1").mkdir(parents=True)

    with (
        patch(
            "scripts.backfill_auto_desk_scratch.list_auto_desk_bare_conversations",
            new=AsyncMock(return_value=[bad, good]),
        ),
        patch(
            "scripts.backfill_auto_desk_scratch.scratch_and_desk_roots",
            side_effect=[
                RuntimeError("disk exploded"),
                (scratch_good, tmp_path / "workspaces" / "u1" / "d1"),
            ],
        ),
    ):
        stats = await backfill_auto_desk_scratch(dry_run=False)

    assert stats.conversations_failed == 1
    assert stats.conversations_moved == 1
    assert (tmp_path / "workspaces" / "u1" / "d1" / "ok.txt").is_file()
