"""Team preview gate — thin preflight before the first worker wave starts."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import team_preview_required, team_preview_resolved
from agentcore.runtime.interaction import InteractionKind
from agentcore.tools.builtin.delegate.schema import PLAN_REVIEW_SUMMARY_CHARS
from agentcore.tools.builtin.delegate.steer import apply_steer
from agentcore.tools.builtin.delegate.suspension import can_persist_suspension, drop_suspension

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)

# Task excerpt on the preview card (aligned with plan_review summary cap).
_TASK_PREVIEW_CHARS = PLAN_REVIEW_SUMMARY_CHARS


def should_preview(plan: RunPlan, *, finalize: bool) -> bool:
    """Whether this first-wave delegate should pause for a thin team preview.

    Hang when ≥2 workers OR any debate-marked node. Skip single-worker + finalize
    (zero-friction solo path). Nested depth / resume / ask_user skip are decided by
    the caller.
    """
    if len(plan.nodes) >= 2:
        return True
    if any(bool(n.stance) or int(n.round or 0) > 0 for n in plan.nodes):
        return True
    if len(plan.nodes) == 1 and finalize:
        return False
    return False


def skip_after_confirmed_ask(tool: DelegateTool) -> bool:
    """Skip preview when this CEO turn already settled a blocking ask_user (avoid dual cards).

    Non-blocking ``question_posted`` or no ask at all → still preview. Only a resolved
    blocking checkpoint in the turn journal (or live sink journal) counts.
    """
    journal = list(tool._sink.execution_journal() or [])
    return any(e.get("type") == "checkpoint_resolved" for e in journal)


def worker_rows(plan: RunPlan) -> list[dict[str, Any]]:
    """Card rows: role / task excerpt / depends_on / debate flag."""
    rows: list[dict[str, Any]] = []
    for n in plan.nodes:
        task = (n.task or n.objective or "").strip()
        if len(task) > _TASK_PREVIEW_CHARS:
            task = task[:_TASK_PREVIEW_CHARS] + "…"
        rows.append(
            {
                "run_id": n.run_id,
                "role": n.role or n.agent_name or n.run_id,
                "task": task,
                "depends_on": list(n.depends_on),
                "debate": bool(n.stance) or int(n.round or 0) > 0,
            }
        )
    return rows


async def persist_team_preview(
    tool: DelegateTool,
    checkpoint_id: str,
    plan: RunPlan,
    workers: list[dict[str, Any]],
    required_event,
) -> bool:
    """Capture + persist the durable team_preview frame. Returns True iff saved."""
    if not can_persist_suspension(tool):
        return False
    from agentcore.runtime.suspension import TeamPreviewSuspension, find_tool_call_id
    from agentcore.runtime.suspension_capture import SuspensionCapture, persist_suspension_capture

    def build_frame(capture: SuspensionCapture) -> TeamPreviewSuspension:
        return TeamPreviewSuspension(
            message_id=tool._message_id or "",
            conversation_id=tool._conversation_id or "",
            user_id=tool._base_tool_context.user_id,
            captain_run_id=tool._captain_run_id or "",
            checkpoint_id=checkpoint_id,
            tool_call_id=find_tool_call_id(capture.transcript, "delegate"),
            base_system_prompt=tool._system_prompt,
            user_message=tool._user_message,
            folder_id=tool._folder_id,
            memory_enabled=tool._memory_enabled,
            transcript=capture.transcript,
            history=capture.history,
            plan=plan,
            completed={},
            journal_entries=capture.journal_entries,
            workers=workers,
            trace_id=capture.trace_id,
        )

    return await persist_suspension_capture(
        checkpoint_id=checkpoint_id,
        required_event=required_event,
        build_frame=build_frame,
        saver=tool._suspension_saver,  # type: ignore[arg-type]
    )


async def await_team_preview(tool: DelegateTool, plan: RunPlan) -> CheckpointDecision | None:
    """Pause before the first wave; return the decision, or None if the gate was skipped.

    On durable save: sets ``tool._pending_pause`` and returns ``None`` so ``drive`` ends
    with SUSPEND (same 挂起即收口 shape as plan_review). On the narrow in-memory fallback:
    applies adjust/stop inline and returns CONTINUE/STOP for the caller to proceed/abort.
    """
    registry = tool._registry
    conversation_id = tool._conversation_id
    if registry is None or conversation_id is None:
        return CheckpointDecision.CONTINUE
    if tool._depth != 0:
        return CheckpointDecision.CONTINUE

    checkpoint_id = new_id()
    workers = worker_rows(plan)
    required = team_preview_required(
        checkpoint_id=checkpoint_id,
        conversation_id=conversation_id,
        workers=workers,
    )
    saved = await persist_team_preview(tool, checkpoint_id, plan, workers, required)
    if saved:
        tool._sink.emit(required)
        tool._pending_pause = True
        logger.info("team_preview.finalized", checkpoint_id=checkpoint_id, workers=len(workers))
        return None

    timeout = tool._checkpoint_timeout_seconds
    try:
        response = await registry.suspend(
            checkpoint_id,
            conversation_id,
            kind=InteractionKind.TEAM_PREVIEW,
            payload={"workers": workers},
            timeout=timeout,
            on_suspended=lambda: tool._sink.emit(required),
        )
    except TimeoutError:
        logger.info("team_preview.timeout", checkpoint_id=checkpoint_id)
        response = CheckpointResponse(decision=CheckpointDecision.CONTINUE)
    await drop_suspension(tool)
    tool._sink.emit(
        team_preview_resolved(
            checkpoint_id=checkpoint_id,
            decision=response.decision.value,
            note=response.note,
        )
    )
    logger.info(
        "team_preview.resolved",
        checkpoint_id=checkpoint_id,
        decision=response.decision.value,
    )
    if response.decision is CheckpointDecision.ADJUST and response.note.strip():
        apply_steer(plan, {}, set(), response.note.strip())
    return response.decision
