"""Turn-lease repository (durable RUNNING ownership)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.models.runs import TurnLeaseRow


class TurnLeaseRepository:
    """Postgres store for in-flight turn leases (swappable for Redis later)."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def upsert(
        self,
        *,
        message_id: str,
        conversation_id: str,
        user_id: str,
        owner_id: str,
        phase: str = "running",
        meta: dict[str, Any] | None = None,
    ) -> None:
        """Acquire / refresh a lease for ``message_id`` under ``owner_id``."""
        now = datetime.now(UTC)
        payload = meta or {}
        stmt = (
            pg_insert(TurnLeaseRow)
            .values(
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                owner_id=owner_id,
                phase=phase,
                meta=payload,
                heartbeat_at=now,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["message_id"],
                set_={
                    "owner_id": owner_id,
                    "phase": phase,
                    "meta": payload,
                    "heartbeat_at": now,
                    "updated_at": now,
                    "conversation_id": conversation_id,
                    "user_id": user_id,
                },
            )
        )
        await self._session.execute(stmt)
        await self._session.commit()

    async def heartbeat(self, message_id: str, *, owner_id: str, phase: str | None = None) -> bool:
        """Bump heartbeat when ``owner_id`` still owns the row. Returns False if lost."""
        now = datetime.now(UTC)
        values: dict[str, Any] = {"heartbeat_at": now, "updated_at": now}
        if phase is not None:
            values["phase"] = phase
        result = await self._session.execute(
            update(TurnLeaseRow)
            .where(
                TurnLeaseRow.message_id == message_id,
                TurnLeaseRow.owner_id == owner_id,
            )
            .values(**values)
        )
        await self._session.commit()
        return (result.rowcount or 0) > 0

    async def release(self, message_id: str, *, owner_id: str | None = None) -> None:
        """Drop the lease (terminal finish / pause / stop). Owner-scoped when given."""
        stmt = delete(TurnLeaseRow).where(TurnLeaseRow.message_id == message_id)
        if owner_id is not None:
            stmt = stmt.where(TurnLeaseRow.owner_id == owner_id)
        await self._session.execute(stmt)
        await self._session.commit()

    async def get(self, message_id: str) -> TurnLeaseRow | None:
        result = await self._session.execute(
            select(TurnLeaseRow).where(TurnLeaseRow.message_id == message_id)
        )
        return result.scalar_one_or_none()

    async def list_expired(self, *, before: datetime, limit: int) -> Sequence[TurnLeaseRow]:
        """Leases whose heartbeat is older than ``before`` (owner presumed dead)."""
        result = await self._session.execute(
            select(TurnLeaseRow)
            .where(TurnLeaseRow.heartbeat_at < before)
            .order_by(TurnLeaseRow.heartbeat_at.asc())
            .limit(limit)
        )
        return result.scalars().all()

    async def claim_expired(
        self,
        message_id: str,
        *,
        new_owner_id: str,
        before: datetime,
        phase: str = "recovering",
    ) -> TurnLeaseRow | None:
        """Atomically take over an expired lease (only one sweeper wins).

        UPDATE … WHERE heartbeat_at < before RETURNING — a second concurrent claim
        sees 0 rows. Returns the row after claim, or ``None``.
        """
        now = datetime.now(UTC)
        result = await self._session.execute(
            update(TurnLeaseRow)
            .where(
                TurnLeaseRow.message_id == message_id,
                TurnLeaseRow.heartbeat_at < before,
            )
            .values(
                owner_id=new_owner_id,
                phase=phase,
                heartbeat_at=now,
                updated_at=now,
            )
            .returning(TurnLeaseRow)
        )
        row = result.scalar_one_or_none()
        await self._session.commit()
        return row
