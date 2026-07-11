"""AuditRecorder — best-effort append-only audit writes for delegated turns."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.db.base import telemetry_session_factory

logger = get_logger(__name__)

current_audit_recorder: ContextVar[AuditRecorder | None] = ContextVar(
    "current_audit_recorder", default=None
)


@dataclass(frozen=True, slots=True)
class AuditDraft:
    category: str
    action: str
    actor_kind: str
    outcome: str
    execution_id: str | None = None
    run_id: str | None = None
    parent_run_id: str | None = None
    target_type: str | None = None
    target_ref: str | None = None
    detail: dict[str, Any] | None = None


class AuditRecorder:
    """Per-turn audit writer — active only after the first delegate in the turn."""

    def __init__(
        self,
        *,
        user_id: str,
        conversation_id: str,
        turn_id: str,
        trace_id: str | None,
        captain_run_id: str | None = None,
        delegated: bool = False,
    ) -> None:
        self.user_id = user_id
        self.conversation_id = conversation_id
        self.turn_id = turn_id
        self.trace_id = trace_id
        self.captain_run_id = captain_run_id
        self._delegated = delegated
        self._next_seq = 0
        self._drops = 0
        self._pending: list[asyncio.Task[None]] = []
        self._tool_args: dict[str, dict[str, Any]] = {}

    @property
    def drops(self) -> int:
        return self._drops

    @property
    def delegated(self) -> bool:
        return self._delegated

    def activate_delegation(self) -> None:
        self._delegated = True

    def remember_tool_args(self, tool_call_id: str, arguments: dict[str, Any]) -> None:
        if tool_call_id:
            self._tool_args[tool_call_id] = dict(arguments)

    def pop_tool_args(self, tool_call_id: str) -> dict[str, Any]:
        return self._tool_args.pop(tool_call_id, {})

    def schedule(self, draft: AuditDraft) -> None:
        if not self._delegated:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._append(draft))
        self._pending.append(task)
        task.add_done_callback(lambda t: self._pending.remove(t) if t in self._pending else None)

    async def flush(self) -> None:
        if self._pending:
            await asyncio.gather(*list(self._pending), return_exceptions=True)

    async def _append(self, draft: AuditDraft) -> None:
        seq = self._next_seq
        self._next_seq += 1
        try:
            from agentcore.db.repositories import AgentAuditEventRepository

            # Telemetry pool — never contend with content-write connections (as-built: 成本配额 §三).
            async with telemetry_session_factory() as db:
                await AgentAuditEventRepository(db).append(
                    user_id=self.user_id,
                    conversation_id=self.conversation_id,
                    turn_id=self.turn_id,
                    trace_id=self.trace_id,
                    seq=seq,
                    category=draft.category,
                    action=draft.action,
                    actor_kind=draft.actor_kind,
                    outcome=draft.outcome,
                    execution_id=draft.execution_id,
                    run_id=draft.run_id,
                    parent_run_id=draft.parent_run_id,
                    target_type=draft.target_type,
                    target_ref=draft.target_ref,
                    detail=draft.detail,
                )
        except Exception as e:  # noqa: BLE001 — audit must never break the turn
            self._drops += 1
            logger.warning(
                "audit.degraded",
                turn_id=self.turn_id,
                seq=seq,
                action=draft.action,
                error=str(e),
            )
