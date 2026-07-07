"""Agent collaboration audit event data access (append-only)."""

from datetime import datetime
from typing import Any

from sqlalchemy import case, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import AgentAuditEvent


class AgentAuditEventRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def append(
        self,
        *,
        user_id: str,
        conversation_id: str,
        turn_id: str,
        seq: int,
        category: str,
        action: str,
        actor_kind: str,
        outcome: str,
        trace_id: str | None = None,
        execution_id: str | None = None,
        run_id: str | None = None,
        parent_run_id: str | None = None,
        target_type: str | None = None,
        target_ref: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> AgentAuditEvent:
        row = AgentAuditEvent(
            id=new_id(),
            user_id=user_id,
            conversation_id=conversation_id,
            turn_id=turn_id,
            trace_id=trace_id,
            execution_id=execution_id,
            run_id=run_id,
            parent_run_id=parent_run_id,
            seq=seq,
            category=category,
            action=action,
            actor_kind=actor_kind,
            target_type=target_type,
            target_ref=target_ref,
            outcome=outcome,
            detail=detail or {},
        )
        self._session.add(row)
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def list_for_turn(
        self,
        *,
        conversation_id: str,
        turn_id: str,
    ) -> list[AgentAuditEvent]:
        result = await self._session.execute(
            select(AgentAuditEvent)
            .where(
                AgentAuditEvent.conversation_id == conversation_id,
                AgentAuditEvent.turn_id == turn_id,
            )
            .order_by(AgentAuditEvent.seq.asc())
        )
        return list(result.scalars().all())

    async def list_for_file(
        self,
        *,
        conversation_id: str,
        path: str,
    ) -> list[AgentAuditEvent]:
        """File-attribution timeline (target_type=file, target_ref matches workspace path)."""
        normalized = path.replace("\\", "/").strip().lstrip("/")
        result = await self._session.execute(
            select(AgentAuditEvent)
            .where(
                AgentAuditEvent.conversation_id == conversation_id,
                AgentAuditEvent.target_type == "file",
                AgentAuditEvent.target_ref == normalized,
            )
            .order_by(AgentAuditEvent.created_at.asc())
        )
        return list(result.scalars().all())

    async def delete_stale(self, *, before: datetime, limit: int) -> int:
        """Delete audit rows older than ``before``; return rows removed (batched)."""
        ids = (
            await self._session.execute(
                select(AgentAuditEvent.id)
                .where(AgentAuditEvent.created_at < before)
                .order_by(AgentAuditEvent.created_at.asc())
                .limit(limit)
            )
        ).scalars().all()
        if not ids:
            return 0
        result = await self._session.execute(
            delete(AgentAuditEvent).where(AgentAuditEvent.id.in_(ids))
        )
        await self._session.commit()
        return int(result.rowcount or 0)

    async def aggregate_summary(self, *, since: datetime) -> dict[str, Any]:
        """Platform-wide audit aggregates for the admin summary widget."""
        stmt = select(
            func.count().label("events"),
            func.coalesce(
                func.sum(
                    case(
                        (AgentAuditEvent.category == "failure", 1),
                        else_=0,
                    )
                ),
                0,
            ).label("failures"),
            func.coalesce(
                func.sum(
                    case(
                        (AgentAuditEvent.action == "approval.timeout", 1),
                        else_=0,
                    )
                ),
                0,
            ).label("approval_timeouts"),
            func.coalesce(
                func.sum(
                    case(
                        (AgentAuditEvent.action == "approval.denied", 1),
                        else_=0,
                    )
                ),
                0,
            ).label("approval_denied"),
            func.coalesce(
                func.sum(
                    case(
                        (AgentAuditEvent.action == "delegate.plan", 1),
                        else_=0,
                    )
                ),
                0,
            ).label("delegate_plans"),
        ).where(AgentAuditEvent.created_at >= since)
        row = (await self._session.execute(stmt)).one()
        return {
            "events": int(row.events or 0),
            "failures": int(row.failures or 0),
            "approval_timeouts": int(row.approval_timeouts or 0),
            "approval_denied": int(row.approval_denied or 0),
            "delegate_plans": int(row.delegate_plans or 0),
        }
