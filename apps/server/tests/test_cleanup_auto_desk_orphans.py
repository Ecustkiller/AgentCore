"""Tests for scripts/cleanup_auto_desk_orphans.py (dry-run + apply)."""

from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from agentcore.config import settings
from scripts.cleanup_auto_desk_orphans import (
    cleanup_auto_desk_orphans,
    folder_is_pointer_orphan,
    is_folder_id_segment,
    summarize_workspace_dir,
)


@pytest.fixture(autouse=True)
def _redirect_data_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))


def test_is_folder_id_segment_accepts_uuid_only():
    fid = str(uuid4())
    assert is_folder_id_segment(fid)
    assert not is_folder_id_segment("conv")
    assert not is_folder_id_segment("shared")
    assert not is_folder_id_segment("not-a-uuid")
    assert not is_folder_id_segment("")


def test_folder_is_pointer_orphan_missing_and_soft_deleted():
    assert folder_is_pointer_orphan(None) is True
    soft = SimpleNamespace(deleted_at=datetime.now(UTC))
    live = SimpleNamespace(deleted_at=None)
    assert folder_is_pointer_orphan(soft) is True  # type: ignore[arg-type]
    assert folder_is_pointer_orphan(live) is False  # type: ignore[arg-type]


def test_summarize_workspace_dir_counts_files(tmp_path: Path):
    root = tmp_path / "desk"
    (root / "AgentCore").mkdir(parents=True)
    (root / "a.txt").write_text("hi", encoding="utf-8")
    (root / "AgentCore" / "note.md").write_text("n\n", encoding="utf-8")

    top, file_count, approx_bytes = summarize_workspace_dir(root)

    assert "a.txt" in top
    assert "AgentCore" in top
    assert file_count == 2
    assert approx_bytes >= 3


@pytest.mark.asyncio
async def test_cleanup_dry_run_clears_neither_pointer_nor_disk(tmp_path: Path):
    user_id = str(uuid4())
    cid = str(uuid4())
    missing_desk = str(uuid4())
    ghost_id = str(uuid4())
    soft_desk = str(uuid4())

    ghost = tmp_path / "workspaces" / user_id / ghost_id
    ghost.mkdir(parents=True)
    (ghost / "keep.txt").write_text("ghost", encoding="utf-8")

    soft_folder = SimpleNamespace(id=soft_desk, deleted_at=datetime.now(UTC))

    with (
        patch(
            "scripts.cleanup_auto_desk_orphans.list_auto_desk_pointer_rows",
            new=AsyncMock(
                return_value=[
                    (cid, user_id, missing_desk),
                    (str(uuid4()), user_id, soft_desk),
                ]
            ),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.load_folders_by_id",
            new=AsyncMock(return_value={soft_desk: soft_folder}),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.clear_auto_desk_pointer",
            new=AsyncMock(),
        ) as clear_mock,
        patch(
            "scripts.cleanup_auto_desk_orphans.list_existing_folder_ids",
            new=AsyncMock(return_value=set()),
        ),
    ):
        stats = await cleanup_auto_desk_orphans(dry_run=True)

    assert stats.pointers_scanned == 2
    assert stats.pointers_cleared == 2
    assert stats.pointers_ok == 0
    assert clear_mock.await_count == 0
    assert stats.ghost_dirs_found == 1
    assert stats.ghost_dirs_deleted == 0
    assert (ghost / "keep.txt").is_file()
    assert stats.ghost_reports[0].folder_id == ghost_id
    assert "keep.txt" in stats.ghost_reports[0].top_level_entries


@pytest.mark.asyncio
async def test_cleanup_apply_nulls_pointers_and_deletes_ghost(tmp_path: Path):
    user_id = str(uuid4())
    cid_missing = str(uuid4())
    cid_soft = str(uuid4())
    cid_ok = str(uuid4())
    missing_desk = str(uuid4())
    soft_desk = str(uuid4())
    live_desk = str(uuid4())
    ghost_id = str(uuid4())
    live_id = str(uuid4())

    ghost = tmp_path / "workspaces" / user_id / ghost_id
    ghost.mkdir(parents=True)
    (ghost / "gone.txt").write_text("x", encoding="utf-8")
    live_dir = tmp_path / "workspaces" / user_id / live_id
    live_dir.mkdir(parents=True)
    (live_dir / "stay.txt").write_text("ok", encoding="utf-8")
    # Reserved scratch segment must never be treated as a folder ghost.
    scratch = tmp_path / "workspaces" / user_id / "conv" / str(uuid4())
    scratch.mkdir(parents=True)
    (scratch / "scratch.txt").write_text("s", encoding="utf-8")

    soft_folder = SimpleNamespace(id=soft_desk, deleted_at=datetime.now(UTC))
    live_folder = SimpleNamespace(id=live_desk, deleted_at=None)
    cleared: list[str] = []

    async def _clear(conversation_id: str) -> None:
        cleared.append(conversation_id)

    with (
        patch(
            "scripts.cleanup_auto_desk_orphans.list_auto_desk_pointer_rows",
            new=AsyncMock(
                return_value=[
                    (cid_missing, user_id, missing_desk),
                    (cid_soft, user_id, soft_desk),
                    (cid_ok, user_id, live_desk),
                ]
            ),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.load_folders_by_id",
            new=AsyncMock(
                return_value={soft_desk: soft_folder, live_desk: live_folder}
            ),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.clear_auto_desk_pointer",
            new=_clear,
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.list_existing_folder_ids",
            new=AsyncMock(return_value={live_id}),
        ),
    ):
        stats = await cleanup_auto_desk_orphans(dry_run=False)

    assert stats.pointers_scanned == 3
    assert stats.pointers_ok == 1
    assert stats.pointers_cleared == 2
    assert set(cleared) == {cid_missing, cid_soft}
    assert stats.ghost_dirs_found == 1
    assert stats.ghost_dirs_deleted == 1
    assert not ghost.exists()
    assert (live_dir / "stay.txt").is_file()
    assert (scratch / "scratch.txt").is_file()


@pytest.mark.asyncio
async def test_cleanup_one_failure_does_not_stop_others(tmp_path: Path):
    user_id = str(uuid4())
    cid_bad = str(uuid4())
    cid_good = str(uuid4())
    desk_bad = str(uuid4())
    desk_good = str(uuid4())
    ghost_bad = str(uuid4())
    ghost_good = str(uuid4())

    bad_path = tmp_path / "workspaces" / user_id / ghost_bad
    good_path = tmp_path / "workspaces" / user_id / ghost_good
    bad_path.mkdir(parents=True)
    good_path.mkdir(parents=True)
    (good_path / "x.txt").write_text("x", encoding="utf-8")

    cleared: list[str] = []

    async def _clear(conversation_id: str) -> None:
        if conversation_id == cid_bad:
            raise RuntimeError("db exploded")
        cleared.append(conversation_id)

    real_rmtree = __import__("shutil").rmtree

    def _rmtree(path, ignore_errors=False):  # noqa: ANN001
        if Path(path).resolve() == bad_path.resolve():
            raise OSError("disk locked")
        return real_rmtree(path, ignore_errors=ignore_errors)

    with (
        patch(
            "scripts.cleanup_auto_desk_orphans.list_auto_desk_pointer_rows",
            new=AsyncMock(
                return_value=[
                    (cid_bad, user_id, desk_bad),
                    (cid_good, user_id, desk_good),
                ]
            ),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.load_folders_by_id",
            new=AsyncMock(return_value={}),
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.clear_auto_desk_pointer",
            new=_clear,
        ),
        patch(
            "scripts.cleanup_auto_desk_orphans.list_existing_folder_ids",
            new=AsyncMock(return_value=set()),
        ),
        patch("scripts.cleanup_auto_desk_orphans.shutil.rmtree", side_effect=_rmtree),
    ):
        stats = await cleanup_auto_desk_orphans(dry_run=False)

    assert stats.pointers_failed == 1
    assert stats.pointers_cleared == 1
    assert cleared == [cid_good]
    assert stats.ghost_dirs_failed == 1
    assert stats.ghost_dirs_deleted == 1
    assert not good_path.exists()
    assert bad_path.exists()
