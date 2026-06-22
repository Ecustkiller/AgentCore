"""Immediate permanent folder deletion (彻底删除项目).

Distinct from ``FolderRepository.soft_delete`` (recoverable container delete with
a retention grace period). This path hard-deletes every live conversation in the
folder, purges the folder's shared workspace + snapshots immediately, then removes
the folder record — the user's「empty recycle bin now」entry.
"""

from __future__ import annotations

from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.workspace.retention import purge_folder_space


async def permanent_delete_folder(*, folder_id: str, user_id: str) -> bool:
    """Physically remove a folder, its cloud workspace, and all member chats.

    Local-bound projects: server metadata + cloud copies are removed; files on the
    user's machine are untouched (they own the disk).
    """
    async with async_session_factory() as session:
        folder_repo = FolderRepository(session)
        conv_repo = ConversationRepository(session)
        folder = await folder_repo.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return False
        conv_ids = await conv_repo.list_ids_by_folder(folder_id, user_id=user_id)

    await purge_folder_space(user_id=user_id, folder_id=folder_id)

    async with async_session_factory() as session:
        conv_repo = ConversationRepository(session)
        folder_repo = FolderRepository(session)
        for conversation_id in conv_ids:
            await conv_repo.hard_delete(conversation_id)
        await folder_repo.hard_delete(folder_id)
    return True
