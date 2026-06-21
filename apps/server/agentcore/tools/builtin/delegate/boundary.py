"""WaveScheduler decision-boundary hook (CHECKPOINT / BIND / SCOPE)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import plan_review_required, plan_review_resolved
from agentcore.runtime.interaction import InteractionKind
from agentcore.tools.builtin.delegate.schema import PLAN_REVIEW_SUMMARY_CHARS
from agentcore.tools.builtin.delegate.steer import apply_steer
from agentcore.tools.builtin.delegate.suspension import drop_suspension, persist_suspension

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunSpec
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


def checkpoint_active(tool: DelegateTool) -> bool:
    """Whether structured checkpoints fire this turn (结构化挂起 2a)."""
    return bool(tool._checkpoint_enabled and tool._registry and tool._conversation_id)


def review_step(node: RunSpec, completed: dict) -> dict[str, Any]:
    """One just-completed checkpoint node's review card entry."""
    state = completed.get(node.run_id)
    summary = (state.content if state else "") or ""
    if len(summary) > PLAN_REVIEW_SUMMARY_CHARS:
        summary = summary[:PLAN_REVIEW_SUMMARY_CHARS] + "…"
    return {"run_id": node.run_id, "role": node.role or node.run_id, "summary": summary}


def pending_preview(plan: RunPlan, completed: dict) -> list[dict[str, Any]]:
    """The downstream nodes about to run once the user proceeds."""
    return [
        {"run_id": n.run_id, "role": n.role or n.run_id}
        for n in plan.nodes
        if n.run_id not in completed
    ]


def boundary_hook(tool: DelegateTool, plan: RunPlan):
    """Build the WaveScheduler ``on_boundary`` hook for ``plan`` (受监督的波循环)."""
    from agentcore.runtime.runs import BoundaryOutcome, BoundaryReason

    registry = tool._registry
    conversation_id = tool._conversation_id
    timeout = tool._checkpoint_timeout_seconds

    async def on_boundary(reason, nodes, completed) -> BoundaryOutcome:
        if reason is BoundaryReason.BIND or reason is BoundaryReason.SCOPE:
            tool._pending_boundary = (reason, list(nodes))
            return BoundaryOutcome.YIELD
        if registry is None or conversation_id is None:
            return BoundaryOutcome.PROCEED

        checkpoint_id = new_id()
        steps = [review_step(n, completed) for n in nodes]
        pending = pending_preview(plan, completed)
        required = plan_review_required(
            checkpoint_id=checkpoint_id,
            conversation_id=conversation_id,
            steps=steps,
            pending=pending,
        )
        await persist_suspension(
            tool, checkpoint_id, plan, completed, steps, pending, required
        )
        try:
            response = await registry.suspend(
                checkpoint_id,
                conversation_id,
                kind=InteractionKind.PLAN_REVIEW,
                payload={"steps": steps, "pending": pending},
                timeout=timeout,
                on_suspended=lambda: tool._sink.emit(required),
            )
        except TimeoutError:
            logger.info("plan_review.timeout", checkpoint_id=checkpoint_id)
            response = CheckpointResponse(decision=CheckpointDecision.CONTINUE)
        await drop_suspension(tool)
        tool._sink.emit(
            plan_review_resolved(
                checkpoint_id=checkpoint_id,
                decision=response.decision.value,
                note=response.note,
            )
        )
        if response.decision is CheckpointDecision.ADJUST and response.note.strip():
            apply_steer(plan, completed, {n.run_id for n in nodes}, response.note.strip())
        return (
            BoundaryOutcome.ABORT
            if response.decision is CheckpointDecision.STOP
            else BoundaryOutcome.PROCEED
        )

    return on_boundary
