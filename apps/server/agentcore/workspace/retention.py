"""Retention cleanup for soft-deleted workspaces (决策⑦: 与软删除对齐).

Deleting a folder or conversation is a *soft* delete (a ``deleted_at`` stamp):
the chat disappears from the UI but its workspace files stay on disk, fully
recoverable. This module is the second half — a periodic background sweep that,
once ``deleted_at`` is older than the retention period, *physically* removes the
workspace directory, its snapshot history, and the DB records. The user's
"empty recycle bin" path can call :func:`run_retention_sweep`'s helpers directly
for an immediate purge.

Ownership follows 决策⑦: files belong to the **project (folder)**. A deleted
folder's conversations were already re-parented to ungrouped at soft-delete (and
start fresh in their own conversation spaces), so a folder purge drops that
folder's orphaned shared space; a deleted *ungrouped* conversation drops its own
space; a deleted *grouped* conversation only loses its records (its files live on
in the still-shared folder space).
"""

from __future__ import annotations

import asyncio
import shutil
from datetime import datetime, timedelta

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.errors import is_schema_error
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.workspace.locate import workspace_root_path, workspace_storage_key
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.snapshots import purge_snapshots

logger = get_logger(__name__)

# `conversation_id` is ignored by the path helpers when a folder_id is given (a
# folder's space is keyed by the folder), so a placeholder reads clearer than "".
_FOLDER_SCOPE = "(folder)"


async def _purge_folder_space(*, user_id: str, folder_id: str) -> None:
    """Delete a folder's shared workspace directory + its snapshot history."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=_FOLDER_SCOPE
    )
    async with workspace_lock(key):
        shutil.rmtree(
            workspace_root_path(
                user_id=user_id, folder_id=folder_id, conversation_id=_FOLDER_SCOPE
            ),
            ignore_errors=True,
        )
        await purge_snapshots(
            user_id=user_id, folder_id=folder_id, conversation_id=_FOLDER_SCOPE
        )


async def _purge_conversation_space(*, user_id: str, conversation_id: str) -> None:
    """Delete an ungrouped conversation's own workspace directory + snapshots."""
    key = workspace_storage_key(
        user_id=user_id, folder_id=None, conversation_id=conversation_id
    )
    async with workspace_lock(key):
        shutil.rmtree(
            workspace_root_path(
                user_id=user_id, folder_id=None, conversation_id=conversation_id
            ),
            ignore_errors=True,
        )
        await purge_snapshots(
            user_id=user_id, folder_id=None, conversation_id=conversation_id
        )


async def run_retention_sweep() -> dict[str, int]:
    """Purge soft-deleted folders/conversations past the retention period once.

    Files are removed *before* the DB record, so a storage failure leaves the
    record soft-deleted for the next sweep to retry rather than orphaning files
    under a deleted record. Each item is isolated: one failure is logged and
    skipped, never aborting the batch. Returns per-kind purge counts.
    """
    if not settings.workspace_retention_enabled:
        return {"folders": 0, "conversations": 0}

    before = datetime.now() - timedelta(days=settings.workspace_retention_days)
    limit = settings.workspace_retention_batch_limit

    async with async_session_factory() as session:
        folders = await FolderRepository(session).list_purgeable(
            before=before, limit=limit
        )
    purged_folders = 0
    for folder in folders:
        try:
            await _purge_folder_space(user_id=folder.user_id, folder_id=folder.id)
        except Exception as e:
            logger.warning(
                "retention.folder_purge_failed", folder_id=folder.id, error=str(e)
            )
            continue
        async with async_session_factory() as session:
            await FolderRepository(session).hard_delete(folder.id)
        purged_folders += 1

    async with async_session_factory() as session:
        conversations = await ConversationRepository(session).list_purgeable(
            before=before, limit=limit
        )
    purged_convs = 0
    for conv in conversations:
        try:
            # A grouped conversation's files belong to the (shared) folder space;
            # only an ungrouped one owns a space to delete.
            if conv.folder_id is None:
                await _purge_conversation_space(
                    user_id=conv.user_id, conversation_id=conv.id
                )
        except Exception as e:
            logger.warning(
                "retention.conversation_purge_failed",
                conversation_id=conv.id,
                error=str(e),
            )
            continue
        async with async_session_factory() as session:
            await ConversationRepository(session).hard_delete(conv.id)
        purged_convs += 1

    return {"folders": purged_folders, "conversations": purged_convs}


async def retention_loop() -> None:
    """Run :func:`run_retention_sweep` forever on the configured interval.

    Started from the app lifespan. A sweep failure is logged and the loop keeps
    going; cancellation (on shutdown) propagates cleanly.
    """
    interval = settings.workspace_retention_sweep_interval_seconds
    while True:
        try:
            result = await run_retention_sweep()
            if result["folders"] or result["conversations"]:
                logger.info("retention.sweep_purged", **result)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            # Best-effort periodic sweep, logged on ONE line (no traceback) so a
            # recurring transient can't flood the AI logs. A schema fault (missing
            # table/column = pending migration) is persistent, not transient —
            # escalate to error so a watchdog catches the sweep silently failing.
            log = logger.error if is_schema_error(e) else logger.warning
            log("retention.sweep_failed", error=str(e))
        await asyncio.sleep(interval)
