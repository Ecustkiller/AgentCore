"""In-process tool-approval coordination (MVP, single-worker).

A GRANTABLE tool call is suspended until the user authorizes it: the running
engine task ``await``s a Future, and a separate HTTP request (the resolve
endpoint) sets that Future. State is in-process — the same single-worker posture
the rate limiter already takes (see ``config.py``); front with Redis to scale to
multiple workers.

Scope: the CEO chat path always. Delegated workers share this SAME per-turn gate
ONLY in local mode (双模式工作区 P2d 执行门) — a worker must not run code or
mutate files on the user's real machine without the same consent the CEO gives.
In cloud mode workers stay un-gated (the server sandbox is isolated) and are
handed no gate.
"""

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.events import EventSink, approval_required, approval_resolved
from agentcore.runtime.interaction import InteractionKind
from agentcore.runtime.ports import ClientRequestBridge

logger = get_logger(__name__)

# Argument values longer than this are truncated in the SSE preview so a big
# file_write/code_execute body does not bloat the approval event.
_PREVIEW_VALUE_MAX = 600


class ApprovalDecision(StrEnum):
    """How the user (or a timeout) settled a tool-approval request."""

    APPROVE = "approve"  # allow this one call
    APPROVE_ALWAYS = "approve_always"  # allow this tool for the rest of the turn
    DENY = "deny"  # refuse; the model is told and may adapt


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
    registry: ClientRequestBridge
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
        preview = _preview_arguments(arguments)
        try:
            decision = await self.registry.suspend(
                approval_id,
                self.conversation_id,
                kind=InteractionKind.APPROVAL,
                payload={
                    "tool_call_id": tool_call_id,
                    "tool_name": tool_name,
                    "arguments": preview,
                },
                timeout=self.timeout_seconds,
                on_suspended=lambda: self.sink.emit(
                    approval_required(
                        approval_id=approval_id,
                        conversation_id=self.conversation_id,
                        tool_call_id=tool_call_id,
                        tool_name=tool_name,
                        arguments=preview,
                    )
                ),
            )
        except TimeoutError:
            logger.info("approval.timeout", tool=tool_name, approval_id=approval_id)
            decision = ApprovalDecision.DENY

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
