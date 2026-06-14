"""In-process tool-approval coordination (MVP, single-worker).

A GRANTABLE tool call is suspended until the user authorizes it: the running
engine task ``await``s a Future, and a separate HTTP request (the resolve
endpoint) sets that Future. State is in-process — the same single-worker posture
the rate limiter already takes (see ``config.py``); front with Redis to scale to
multiple workers.

Scope: the CEO chat path only. Delegated workers run without a gate (they are
never handed an ``ApprovalGate``), so their tool calls are not yet gated.
"""

import asyncio
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import EventSink, approval_required, approval_resolved

logger = get_logger(__name__)

# Argument values longer than this are truncated in the SSE preview so a big
# file_write/code_execute body does not bloat the approval event.
_PREVIEW_VALUE_MAX = 600


class ApprovalDecision(StrEnum):
    """How the user (or a timeout) settled a tool-approval request."""

    APPROVE = "approve"  # allow this one call
    APPROVE_ALWAYS = "approve_always"  # allow this tool for the rest of the turn
    DENY = "deny"  # refuse; the model is told and may adapt


@dataclass
class _Pending:
    """A suspended request: the Future to settle + the owning conversation."""

    future: asyncio.Future[ApprovalDecision]
    conversation_id: str


class ApprovalRegistry:
    """Maps a pending ``approval_id`` to the Future the engine awaits.

    Bridges the engine task (producer of the request, consumer of the decision)
    and the resolve HTTP request (which delivers the decision). Both run in the
    same process/event loop in the MVP. Each request is tagged with its
    ``conversation_id`` so the resolve endpoint can refuse a settle aimed at a
    different conversation (defense-in-depth on top of the route's ownership
    check — tool-call ids are otherwise the only key).
    """

    def __init__(self) -> None:
        self._pending: dict[str, _Pending] = {}

    def create(
        self, approval_id: str, conversation_id: str
    ) -> asyncio.Future[ApprovalDecision]:
        """Register a pending request and return its Future to await."""
        fut: asyncio.Future[ApprovalDecision] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending[approval_id] = _Pending(
            future=fut, conversation_id=conversation_id
        )
        return fut

    def resolve(
        self, approval_id: str, decision: ApprovalDecision, *, conversation_id: str
    ) -> bool:
        """Settle a pending request.

        Returns False if the request is unknown, already settled, or belongs to a
        different conversation than the caller claims.
        """
        pending = self._pending.get(approval_id)
        if pending is None or pending.future.done():
            return False
        if pending.conversation_id != conversation_id:
            return False
        pending.future.set_result(decision)
        return True

    def discard(self, approval_id: str) -> None:
        """Forget a request once the engine is done awaiting it."""
        self._pending.pop(approval_id, None)


_registry = ApprovalRegistry()


def default_approval_registry() -> ApprovalRegistry:
    """The process-wide approval registry (shared by engine + resolve endpoint)."""
    return _registry


def _preview_arguments(arguments: dict[str, Any]) -> dict[str, Any]:
    """Bound large string values so the approval SSE event stays small."""
    preview: dict[str, Any] = {}
    for key, value in arguments.items():
        if isinstance(value, str) and len(value) > _PREVIEW_VALUE_MAX:
            preview[key] = value[:_PREVIEW_VALUE_MAX] + "… [truncated]"
        else:
            preview[key] = value
    return preview


@dataclass
class ApprovalGate:
    """Per-turn gate suspending GRANTABLE tool calls until the user decides.

    One instance per chat turn. ``_granted`` remembers tools the user chose to
    allow for the rest of the turn, so a repeat call to the same tool does not
    re-prompt.
    """

    sink: EventSink
    conversation_id: str
    registry: ApprovalRegistry
    timeout_seconds: float
    _granted: set[str] = field(default_factory=set)

    async def authorize(
        self, *, tool_name: str, tool_call_id: str, arguments: dict[str, Any]
    ) -> ApprovalDecision:
        """Block until the user authorizes (or denies) this tool call.

        ``APPROVE_ALWAYS`` also whitelists ``tool_name`` for the rest of the turn.
        A timeout is treated as ``DENY`` — a request is never silently allowed.
        An already-granted tool returns ``APPROVE`` immediately (no prompt).
        """
        if tool_name in self._granted:
            return ApprovalDecision.APPROVE

        approval_id = tool_call_id
        fut = self.registry.create(approval_id, self.conversation_id)
        self.sink.emit(
            approval_required(
                approval_id=approval_id,
                conversation_id=self.conversation_id,
                tool_call_id=tool_call_id,
                tool_name=tool_name,
                arguments=_preview_arguments(arguments),
            )
        )
        try:
            decision = await asyncio.wait_for(fut, timeout=self.timeout_seconds)
        except TimeoutError:
            logger.info("approval_timeout", tool=tool_name, approval_id=approval_id)
            decision = ApprovalDecision.DENY
        finally:
            self.registry.discard(approval_id)

        if decision is ApprovalDecision.APPROVE_ALWAYS:
            self._granted.add(tool_name)
        self.sink.emit(
            approval_resolved(
                approval_id=approval_id,
                tool_call_id=tool_call_id,
                decision=decision,
            )
        )
        return decision
