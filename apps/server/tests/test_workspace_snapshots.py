"""Tests for the snapshot service (conversation → workspace → StorageProvider).

End-to-end over the filesystem backend: resolves a conversation's workspace via
``locate``, snapshots it, lists/reads/restores it. ``data_dir`` and the storage
backend are redirected to ``tmp_path`` so nothing touches the real ./data tree;
the lru-cached factory is cleared around each test so the redirect takes effect.
"""

from pathlib import Path

import pytest

from agentcore.config import settings
from agentcore.storage import SnapshotNotFound
from agentcore.storage.factory import build_storage_provider
from agentcore.workspace.locate import resolve_workspace_root
from agentcore.workspace.snapshots import (
    create_snapshot,
    list_snapshots,
    read_snapshot,
    restore_snapshot,
)


@pytest.fixture
def fs_storage(tmp_path: Path, monkeypatch):
    """Redirect data_dir + force the filesystem backend, with a clean factory cache."""
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "storage_backend", "filesystem")
    build_storage_provider.cache_clear()
    try:
        yield
    finally:
        build_storage_provider.cache_clear()


async def test_create_then_list_and_download(fs_storage):
    root = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    (root / "report.md").write_text("done", encoding="utf-8")

    ref = await create_snapshot(user_id="u1", folder_id="f1", conversation_id="c1")
    listed = await list_snapshots(user_id="u1", folder_id="f1", conversation_id="c1")
    assert [r.snapshot_id for r in listed] == [ref.snapshot_id]

    data = await read_snapshot(
        user_id="u1", folder_id="f1", conversation_id="c1", snapshot_id=ref.snapshot_id
    )
    assert data[:2] == b"PK"


async def test_restore_recovers_deleted_file(fs_storage):
    root = resolve_workspace_root(user_id="u1", folder_id=None, conversation_id="c9")
    (root / "keep.txt").write_text("v1", encoding="utf-8")
    ref = await create_snapshot(user_id="u1", folder_id=None, conversation_id="c9")

    # User (or agent) wipes the file after the snapshot.
    (root / "keep.txt").unlink()
    assert not (root / "keep.txt").exists()

    await restore_snapshot(
        user_id="u1", folder_id=None, conversation_id="c9", snapshot_id=ref.snapshot_id
    )
    assert (root / "keep.txt").read_text(encoding="utf-8") == "v1"


async def test_folder_conversations_share_snapshots(fs_storage):
    """Two conversations in the same folder see the same snapshot history."""
    root = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    (root / "shared.txt").write_text("x", encoding="utf-8")
    ref = await create_snapshot(user_id="u1", folder_id="f1", conversation_id="c1")

    # A sibling conversation in the same folder resolves the same workspace.
    listed = await list_snapshots(user_id="u1", folder_id="f1", conversation_id="c2")
    assert ref.snapshot_id in {r.snapshot_id for r in listed}


async def test_label_is_preserved(fs_storage):
    root = resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    (root / "a.txt").write_text("x", encoding="utf-8")
    await create_snapshot(
        user_id="u1", folder_id="f1", conversation_id="c1", label="milestone"
    )
    listed = await list_snapshots(user_id="u1", folder_id="f1", conversation_id="c1")
    assert listed[0].label == "milestone"


async def test_read_unknown_snapshot_raises(fs_storage):
    resolve_workspace_root(user_id="u1", folder_id="f1", conversation_id="c1")
    with pytest.raises(SnapshotNotFound):
        await read_snapshot(
            user_id="u1", folder_id="f1", conversation_id="c1", snapshot_id="missing"
        )
