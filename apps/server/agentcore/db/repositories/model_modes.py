"""Custom 质量档 (ModelMode) data access."""

from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import ModelMode


class ModelModeRepository:
    """User-defined custom 质量档 (llm/modes.py D2). System presets are code-defined."""

    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self, *, user_id: str, name: str, assignments: dict[str, str]
    ) -> ModelMode:
        mode = ModelMode(
            id=new_id(), user_id=user_id, name=name, assignments=assignments
        )
        self._session.add(mode)
        await self._session.commit()
        await self._session.refresh(mode)
        return mode

    async def get_by_id(
        self, mode_id: str, *, user_id: str | None = None
    ) -> ModelMode | None:
        conditions = [ModelMode.id == mode_id, ModelMode.deleted_at.is_(None)]
        if user_id is not None:
            conditions.append(ModelMode.user_id == user_id)
        result = await self._session.execute(select(ModelMode).where(*conditions))
        return result.scalar_one_or_none()

    async def list_by_user(self, user_id: str) -> Sequence[ModelMode]:
        """A user's live custom modes, in creation order."""
        result = await self._session.execute(
            select(ModelMode)
            .where(ModelMode.user_id == user_id, ModelMode.deleted_at.is_(None))
            .order_by(ModelMode.created_at.asc())
        )
        return result.scalars().all()

    async def assignments_by_user(self, user_id: str) -> dict[str, dict[str, str]]:
        """``{mode_id: assignments}`` for the turn resolver (llm/modes.py).

        Loaded once per turn so a conversation/user referencing a custom mode can be
        resolved without the resolver touching the DB (keeps it pure).
        """
        modes = await self.list_by_user(user_id)
        return {m.id: dict(m.assignments or {}) for m in modes}

    async def update(
        self,
        mode_id: str,
        *,
        user_id: str,
        name: str | None = None,
        assignments: dict[str, str] | None = None,
    ) -> ModelMode | None:
        mode = await self.get_by_id(mode_id, user_id=user_id)
        if not mode:
            return None
        if name is not None:
            mode.name = name
        if assignments is not None:
            mode.assignments = assignments
        await self._session.commit()
        await self._session.refresh(mode)
        return mode

    async def soft_delete(self, mode_id: str, *, user_id: str) -> bool:
        mode = await self.get_by_id(mode_id, user_id=user_id)
        if not mode:
            return False
        mode.deleted_at = datetime.now()
        await self._session.commit()
        return True
