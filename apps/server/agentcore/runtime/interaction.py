"""Unified interaction primitive — the one suspend-resume bridge (§8.2 / §8.6).

A turn suspends whenever it needs something out-of-band settled by the client: a
GRANTABLE tool awaiting the user's approval, the CEO's ``ask_user`` checkpoint, or a
bound desktop running a local-workspace op. All three are the SAME shape — the
engine task ``await``s an :class:`asyncio.Future`; a separate HTTP request (the
resolve endpoint) sets it — so they share ONE registry instead of three parallel
ones.

This is the §8.6 **ClientRequestBridge** port (Protocol in ``runtime/ports.py``):
one pending registry → one ``list_pending`` → one resolve endpoint. Per-kind
differences (the typed result; whether the exchange is journaled) stay in the thin
typed faces: :class:`~agentcore.runtime.approvals.ApprovalGate`,
:class:`~agentcore.tools.builtin.ask_user.AskUserTool`,
:class:`~agentcore.workspace.channel.WorkspaceChannel`.

State is in-process (single-worker posture, like the rate limiter — see
``config.py``); front with Redis to scale to multiple workers. Each request is
tagged with its ``conversation_id`` so a resolve aimed at another conversation is
refused (defense in depth on top of the route's ownership check — the request id is
otherwise the only key).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class InteractionKind(StrEnum):
    """The kinds of suspend point that share the bridge."""

    APPROVAL = "approval"  # GRANTABLE tool gate → result: ApprovalDecision
    ASK_USER = "ask_user"  # CEO checkpoint → result: CheckpointResponse
    CLIENT_TOOL = "client_tool"  # desktop workspace op → result: envelope dict
    # DAG structured checkpoint (结构化挂起 2a): the WaveScheduler paused after a
    # ``checkpoint_after`` step → result: CheckpointResponse (continue / stop).
    PLAN_REVIEW = "plan_review"
    # 团队预审薄预览: first ``delegate`` wave paused BEFORE workers start → result:
    # CheckpointResponse (continue / adjust / stop). Durable like plan_review; distinct
    # kind so it never collides with 波间 plan_review.
    TEAM_PREVIEW = "team_preview"
    # 阻塞式求决策 (escalate blocking=true): a delegated worker hit a「猜错就作废」fork and
    # suspended. Classic path asks the user directly; coordination-active path awaits CEO
    # ``resolve_escalation`` (awaiting=ceo, not user-answerable) →
    # result: ``{answer | use_assumption}``.
    # Unlike the halting gates above, this does NOT pause the turn — siblings keep running
    # and a timeout degrades to the worker's stated assumption (设计: 06-规划/阻塞式求决策设计).
    ESCALATION = "escalation"
    # 委派级授权 (delegation grant): the CEO's delegate call suspends before workers
    # start so the user can grant medium-risk tools for the whole delegation in one
    # click → result: DelegationAuthorizationDecision (grant_delegation / per_call / deny).
    DELEGATION_AUTHORIZATION = "delegation_authorization"


@dataclass
class InteractionRequest:
    """A suspended interaction: its identity + the Future its awaiter is blocked on.

    ``payload`` is the request body emitted to the client (kept so a future
    ``list_pending`` consumer can re-render a pending card on reconnect); ``future``
    settles with the kind-specific result the resolve endpoint delivers.
    """

    id: str
    kind: InteractionKind
    conversation_id: str
    future: asyncio.Future[Any]
    payload: dict[str, Any] = field(default_factory=dict)


class InteractionRegistry:
    """Process-wide bridge mapping a pending ``request_id`` → its awaiter's Future.

    Replaces the three per-kind registries (approval / checkpoint / workspace-op):
    the engine task ``create``s a request and awaits its Future; the resolve
    endpoint ``resolve``s it. One instance holds every kind, so there is a single
    source of pending interactions (``list_pending``) and a single resolve path —
    the §8.6 ClientRequestBridge. Bridges the engine task (producer of the request,
    consumer of the result) and the resolve HTTP request (which delivers it); both
    run in the same process / event loop in the MVP.
    """

    def __init__(self) -> None:
        self._pending: dict[str, InteractionRequest] = {}

    def create(
        self,
        request_id: str,
        conversation_id: str,
        *,
        kind: InteractionKind,
        payload: dict[str, Any] | None = None,
    ) -> asyncio.Future[Any]:
        """Register a pending interaction and return the Future to await.

        ``payload`` mirrors the ``*_required`` event body (for ``list_pending``);
        the awaiting face owns the result's type (a decision enum, the user's
        checkpoint answer, the desktop's op envelope).
        """
        fut: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = InteractionRequest(
            id=request_id,
            kind=kind,
            conversation_id=conversation_id,
            future=fut,
            payload=payload or {},
        )
        return fut

    def resolve(self, request_id: str, result: Any, *, conversation_id: str) -> bool:
        """Settle a pending interaction with its (kind-specific) result.

        Returns False if the request is unknown, already settled, or belongs to a
        different conversation than the caller claims.
        """
        pending = self._pending.get(request_id)
        if pending is None or pending.future.done():
            return False
        if pending.conversation_id != conversation_id:
            return False
        pending.future.set_result(result)
        return True

    async def suspend(
        self,
        request_id: str,
        conversation_id: str,
        *,
        kind: InteractionKind,
        payload: dict[str, Any] | None = None,
        timeout: float | None,
        on_suspended: Callable[[], None] | None = None,
    ) -> Any:
        """Register a pending interaction, signal it, and await its resolution.

        The create → signal → await → discard dance every face (approval / ask_user
        / client_tool / plan_review) used to copy verbatim. ``on_suspended`` is
        invoked right AFTER the entry is registered and BEFORE the await, so a racing
        resolve always finds it — each face passes its ``*_required`` SSE emit here.
        Raises :class:`TimeoutError` when unresolved within ``timeout`` (the caller
        maps it to its kind-specific default + log + ``*_resolved`` emit, or re-raises
        a typed error). ``timeout=None`` waits indefinitely (提问确认交互统一 D2).
        The entry is ALWAYS discarded on exit — resolved, timed out, or cancelled —
        so no face can leak a pending request. Per-kind differences (the result type,
        the resolved emit, the timeout default) stay in the faces.
        """
        fut = self.create(request_id, conversation_id, kind=kind, payload=payload)
        if on_suspended is not None:
            on_suspended()
        try:
            if timeout is None:
                return await fut
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self.discard(request_id)

    def get(self, request_id: str) -> InteractionRequest | None:
        """Look up a pending interaction (e.g. to verify its kind before resolving)."""
        return self._pending.get(request_id)

    def discard(self, request_id: str) -> None:
        """Forget a request once its awaiter is done with it."""
        self._pending.pop(request_id, None)

    def list_pending(self, conversation_id: str | None = None) -> list[InteractionRequest]:
        """All un-settled interactions, optionally scoped to one conversation."""
        items = [r for r in self._pending.values() if not r.future.done()]
        if conversation_id is not None:
            items = [r for r in items if r.conversation_id == conversation_id]
        return items


_registry = InteractionRegistry()


def default_interaction_registry() -> InteractionRegistry:
    """The process-wide interaction registry (engine faces + resolve endpoint)."""
    return _registry
