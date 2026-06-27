"""Folder (对话文件夹 / 本地绑定项目) data access."""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import Board, Conversation, Folder

from ._base import _UNSET, _ilike_pattern


class FolderRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        name: str,
        local_dir: str | None = None,
        local_root_id: str | None = None,
        local_subpath: str | None = None,
    ) -> Folder:
        # ``local_root_id`` binds the folder to a desktop FS root at creation (文件
        # 中枢统一 F2): the hub's "添加文件夹 = 建本地绑定项目" is one insert, not a
        # create-then-bind round trip. ``local_subpath`` (工作区对称化 D1a) marks a
        # per-conversation workspace lazily promoted under a shared container root;
        # NULL for an explicitly-added project bound at its root.
        folder = Folder(
            id=new_id(),
            user_id=user_id,
            name=name,
            local_dir=local_dir,
            local_root_id=local_root_id,
            local_subpath=local_subpath,
        )
        self._session.add(folder)
        await self._session.commit()
        await self._session.refresh(folder)
        return folder

    async def get_by_id(self, folder_id: str, *, user_id: str | None = None) -> Folder | None:
        conditions = [Folder.id == folder_id, Folder.deleted_at.is_(None)]
        if user_id is not None:
            conditions.append(Folder.user_id == user_id)
        result = await self._session.execute(select(Folder).where(*conditions))
        return result.scalar_one_or_none()

    async def list_by_user(self, user_id: str) -> Sequence[Folder]:
        """A user's live folders, in creation order (sidebar group order)."""
        result = await self._session.execute(
            select(Folder)
            .where(Folder.user_id == user_id, Folder.deleted_at.is_(None))
            .order_by(Folder.created_at.asc())
        )
        return result.scalars().all()

    async def search(self, user_id: str, query: str, *, limit: int) -> Sequence[Folder]:
        """Owner-scoped folder-name substring search (全局搜索 Tier 1).

        ILIKE over ``name``, most-recently-updated first, capped at ``limit``;
        soft-deleted folders are excluded.
        """
        result = await self._session.execute(
            select(Folder)
            .where(
                Folder.user_id == user_id,
                Folder.deleted_at.is_(None),
                Folder.name.ilike(_ilike_pattern(query)),
            )
            .order_by(Folder.updated_at.desc())
            .limit(limit)
        )
        return result.scalars().all()

    async def update(
        self,
        folder_id: str,
        *,
        user_id: str,
        name: str | None = None,
        local_dir: str | None | object = _UNSET,
    ) -> Folder | None:
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return None
        if name is not None:
            folder.name = name
        if local_dir is not _UNSET:
            # Explicit None clears the binding (disconnect the local directory).
            folder.local_dir = local_dir  # type: ignore[assignment]
        await self._session.commit()
        await self._session.refresh(folder)
        return folder

    async def set_local_root_id(
        self, folder_id: str, root_id: str | None, *, user_id: str
    ) -> Folder | None:
        """Bind (or unbind, with ``root_id=None``) a folder to a desktop FS root.

        The folder is the shared project space (双模式工作区 §七), so this flips
        every conversation in it to local mode against ``root_id`` (or back to
        cloud when cleared).
        """
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if folder:
            folder.local_root_id = root_id
            await self._session.commit()
            await self._session.refresh(folder)
        return folder

    async def soft_delete(self, folder_id: str, *, user_id: str) -> bool:
        """Soft-delete a folder; its conversations fall back to ungrouped.

        The conversations themselves are kept — only their membership is cleared
        (``folder_id`` → NULL), so deleting a folder never loses chats.
        """
        folder = await self.get_by_id(folder_id, user_id=user_id)
        if not folder:
            return False
        folder.deleted_at = datetime.now()
        await self._session.execute(
            update(Conversation)
            .where(
                Conversation.user_id == user_id,
                Conversation.folder_id == folder_id,
            )
            .values(folder_id=None)
        )
        # Boards in this folder fall back to ungrouped too (never lose a board to a
        # deleted folder — symmetric with conversations above).
        await self._session.execute(
            update(Board)
            .where(Board.user_id == user_id, Board.folder_id == folder_id)
            .values(folder_id=None)
        )
        await self._session.commit()
        return True

    async def list_purgeable(self, *, before: datetime, limit: int) -> Sequence[Folder]:
        """Soft-deleted folders whose ``deleted_at`` is at/older than ``before``.

        Backs retention cleanup (决策⑦). A deleted folder's conversations were
        already re-parented to ungrouped at soft-delete, so only the folder's own
        (orphaned) project workspace + record remain to purge.
        """
        result = await self._session.execute(
            select(Folder)
            .where(Folder.deleted_at.is_not(None), Folder.deleted_at <= before)
            .order_by(Folder.deleted_at.asc())
            .limit(limit)
        )
        return result.scalars().all()

    async def hard_delete(self, folder_id: str) -> None:
        """Physically remove a folder record (its conversations are already detached)."""
        await self._session.execute(delete(Folder).where(Folder.id == folder_id))
        await self._session.commit()
