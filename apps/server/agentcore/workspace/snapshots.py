"""Workspace snapshot service — conversation → workspace → StorageProvider.

Thin orchestration over ``locate.py`` (path policy) and ``storage`` (the
configured provider). Both the post-turn auto-backup (``conversation/service``)
and the snapshot API routes go through here, so "which conversation → which
storage key / root" lives in exactly one place. Path policy never leaks into the
storage layer; provider choice never leaks into the routes.
"""

from __future__ import annotations

from agentcore.storage import SnapshotRef, build_storage_provider
from agentcore.workspace.locate import resolve_workspace_root, workspace_storage_key


async def create_snapshot(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    label: str | None = None,
) -> SnapshotRef:
    """Snapshot a conversation's workspace. A ``label`` marks a kept version."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    root = resolve_workspace_root(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await build_storage_provider().snapshot(root, key, label=label)


async def list_snapshots(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> list[SnapshotRef]:
    """List a conversation's workspace snapshots, newest first."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await build_storage_provider().list_snapshots(key)


async def restore_snapshot(
    *, user_id: str, folder_id: str | None, conversation_id: str, snapshot_id: str
) -> None:
    """Extract a snapshot over the conversation's workspace (``SnapshotNotFound``)."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    root = resolve_workspace_root(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    await build_storage_provider().restore(key, snapshot_id, root)


async def read_snapshot(
    *, user_id: str, folder_id: str | None, conversation_id: str, snapshot_id: str
) -> bytes:
    """Return a snapshot archive (zip) bytes for download (``SnapshotNotFound``)."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await build_storage_provider().read_snapshot(key, snapshot_id)
