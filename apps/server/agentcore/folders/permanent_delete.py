"""Immediate permanent folder deletion (彻底删除文件夹).

Distinct from ``FolderRepository.soft_delete`` (recoverable container delete with
a retention grace period). This path ungroups every live conversation in the
folder, then removes the folder record — conversations and their scratch spaces
are retained.
"""

from __future__ import annotations

from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, FolderRepository


async def permanent_delete_folder(*, folder_id: str, user_id: str) -> bool:
    """Physically remove a folder after ungrouping its member conversations."""
    async with async_session_factory() as session:
        folder_repo = FolderRepository(session)
        conv_repo = ConversationRepository(session)
        folder = await folder_repo.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return False
        conv_ids = await conv_repo.list_ids_by_folder(folder_id, user_id=user_id)

    async with async_session_factory() as session:
        conv_repo = ConversationRepository(session)
        folder_repo = FolderRepository(session)
        for conversation_id in conv_ids:
            await conv_repo.set_folder(conversation_id, None, user_id=user_id)
        await folder_repo.hard_delete(folder_id)
    return True
