"""Bridge worker escalate / note-wall signals into the CEO coordination queue.

Phase 3: when a :class:`CoordinationSession` is active, escalations and note-wall
conflicts post into the event queue so the living CEO can arbitrate — they do
**not** force a supervised SCOPE wave-boundary YIELD.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    active_coordination,
)

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec, RunState
    from agentcore.runtime.runs.wave import BoundaryOutcome, BoundaryReason

logger = get_logger(__name__)

OnBoundary = Callable[
    ["BoundaryReason", list["RunSpec"], dict[str, "RunState"]],
    Awaitable["BoundaryOutcome"],
]


def post_escalation_to_coordination(
    *,
    run_id: str,
    role: str = "",
    kind: str = "normal",
    question: str = "",
    assumption: str = "",
    blocking: bool = False,
    source: str = "escalate",
    summary: str = "",
    execution_id: str | None = None,
    escalation_id: str = "",
) -> bool:
    """Post an escalation into the active coordination queue. Returns True if posted."""
    session = active_coordination(execution_id)
    if session is None or not session.active:
        return False
    posted = session.post(
        CoordinationEvent(
            kind=CoordinationEventKind.ESCALATION,
            payload={
                "run_id": run_id,
                "role": role or run_id,
                "kind": kind,
                "question": question,
                "assumption": assumption,
                "blocking": blocking,
                "source": source,
                "summary": summary or question,
                "escalation_id": escalation_id,
            },
        )
    )
    if posted:
        logger.info(
            "coordination.escalation_routed",
            run_id=run_id,
            kind=kind,
            source=source,
            blocking=blocking,
            execution_id=session.execution_id,
        )
    return posted


def post_note_to_coordination(
    *,
    run_id: str,
    role: str = "",
    kind: str = "note",
    text: str = "",
    conflict: str | None = None,
    execution_id: str | None = None,
) -> None:
    """Post a note_posted event; conflicts also raise an escalation for CEO arbitration."""
    session = active_coordination(execution_id)
    if session is None or not session.active:
        return
    session.post(
        CoordinationEvent(
            kind=CoordinationEventKind.NOTE_POSTED,
            payload={
                "run_id": run_id,
                "role": role or run_id,
                "kind": kind,
                "text": text,
            },
        )
    )
    if conflict:
        post_escalation_to_coordination(
            run_id=run_id,
            role=role,
            kind="note_conflict",
            question=conflict,
            summary=text,
            source="note_wall",
            execution_id=execution_id,
        )


def post_completed_escalations(
    session: CoordinationSession,
    plan: RunPlan,
    completed: dict[str, RunState],
    *,
    newly: set[str],
) -> None:
    """Surface transcript-harvested escalations on newly terminal workers (safety net)."""
    for run_id in newly:
        state = completed.get(run_id)
        if state is None or not state.escalations:
            continue
        node = plan.by_id(run_id)
        role = (node.role if node else None) or run_id
        for esc in state.escalations:
            if esc.get("consumed"):
                continue
            session.post(
                CoordinationEvent(
                    kind=CoordinationEventKind.ESCALATION,
                    payload={
                        "run_id": run_id,
                        "role": role,
                        "kind": esc.get("kind") or "normal",
                        "question": esc.get("question") or "",
                        "assumption": esc.get("assumption") or "",
                        "blocking": bool(esc.get("blocking")),
                        "source": "run_state",
                        "summary": esc.get("question") or "",
                    },
                )
            )


def coordination_boundary_hook(
    session: CoordinationSession,
    base_hook: OnBoundary | None,
) -> OnBoundary:
    """Wrap the supervised boundary hook: SCOPE → event queue + PROCEED (no YIELD).

    CHECKPOINT under coordination is handled inside ``boundary_hook`` (active session →
    ``_pending_boundary`` + YIELD, no durable plan_review). BIND still delegates to base.
    """

    async def on_boundary(
        reason: BoundaryReason,
        nodes: list[RunSpec],
        completed: dict[str, RunState],
    ) -> BoundaryOutcome:
        from agentcore.runtime.runs import BoundaryOutcome, BoundaryReason

        if reason is BoundaryReason.SCOPE and session.active:
            # Live escalate / completion harvest already queued the signal; here we only
            # suppress YIELD so the wave keeps running while the CEO arbitrates.
            for node in nodes:
                state = completed.get(node.run_id)
                role = node.role or node.run_id
                if state is not None:
                    for e in state.escalations:
                        if e.get("kind") in ("scope", "dep") and not e.get("consumed"):
                            session.post(
                                CoordinationEvent(
                                    kind=CoordinationEventKind.ESCALATION,
                                    payload={
                                        "run_id": node.run_id,
                                        "role": role,
                                        "kind": e.get("kind") or "scope",
                                        "question": e.get("question") or "",
                                        "assumption": e.get("assumption") or "",
                                        "blocking": bool(e.get("blocking")),
                                        "source": "scope_boundary",
                                        "summary": e.get("question") or "",
                                    },
                                )
                            )
            logger.info(
                "coordination.scope_proceed",
                execution_id=session.execution_id,
                nodes=[n.run_id for n in nodes],
            )
            # Wave marks escalations consumed after on_boundary returns; keep scheduling.
            return BoundaryOutcome.PROCEED

        if base_hook is not None:
            return await base_hook(reason, nodes, completed)
        return BoundaryOutcome.PROCEED

    return on_boundary


def wrap_executor_with_timeouts(
    executor: Callable[..., Awaitable["RunState"]],
    session: CoordinationSession,
) -> Callable[..., Awaitable["RunState"]]:
    """Arm per-worker timeout timers around the real executor (notify only, no cancel)."""

    async def coordinated_executor(spec: RunSpec, completed: dict[str, RunState]) -> RunState:
        role = spec.role or spec.agent_name or spec.run_id
        timeout_s = spec.policy.timeout_s
        session.arm_worker_timeout(spec.run_id, role=role, timeout_s=timeout_s)
        try:
            return await executor(spec, completed)
        finally:
            session.disarm_worker_timeout(spec.run_id)

    return coordinated_executor
