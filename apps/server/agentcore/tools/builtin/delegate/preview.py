"""Team kickoff gate — plan preview + capability authorization in one card.

Merges the former ``team_preview`` (计划确认) and ``delegation_authorization``
(能力授权) into a single durable pause before the first worker wave. Event type
names stay ``team_preview_*`` (冷路契约); the card is the「开工卡」.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import AutonomyPolicy, new_id
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import team_preview_required
from agentcore.tools.builtin import delegation_grantable_tool_names
from agentcore.tools.builtin.delegate.schema import PLAN_REVIEW_SUMMARY_CHARS
from agentcore.tools.builtin.delegate.suspension import can_persist_suspension

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)

# Task excerpt on the preview card (aligned with plan_review summary cap).
_TASK_PREVIEW_CHARS = PLAN_REVIEW_SUMMARY_CHARS


def should_preview_plan(plan: RunPlan, *, finalize: bool) -> bool:
    """Whether the plan half of the kickoff card should show (计划确认维度).

    Hang when ≥2 workers OR any debate-marked node. Skip single-worker + finalize
    (zero-friction solo path). Nested depth / resume / ask_user skip are decided by
    the caller. AutonomyPolicy does NOT gate this — it only controls capability auth.
    """
    if len(plan.nodes) >= 2:
        return True
    if any(bool(n.stance) or int(n.round or 0) > 0 for n in plan.nodes):
        return True
    if len(plan.nodes) == 1 and finalize:
        return False
    return False


# Back-compat alias used by tests / call sites that still say should_preview.
should_preview = should_preview_plan


def needs_capability_auth(
    *,
    local_gate: bool,
    autonomy: AutonomyPolicy,
) -> bool:
    """Whether the capability-auth half of the kickoff applies.

    - ``always_ask``: no kickoff grant (every call prompts) → False
    - ``full_auto``: auto-grant without listing tools → False (handled silently)
    - ``first_grant`` + local gate: True (show tools / await grant-or-per-call)
    """
    if not local_gate:
        return False
    if autonomy is AutonomyPolicy.ALWAYS_ASK:
        return False
    if autonomy is AutonomyPolicy.FULL_AUTO:
        return False
    return True


def should_kickoff(
    plan: RunPlan,
    *,
    finalize: bool,
    local_gate: bool,
    autonomy: AutonomyPolicy,
) -> bool:
    """Whether to durable-pause for the merged kickoff card."""
    if should_preview_plan(plan, finalize=finalize):
        return True
    return needs_capability_auth(local_gate=local_gate, autonomy=autonomy)


def skip_after_confirmed_ask(tool: DelegateTool) -> bool:
    """Skip kickoff when this CEO turn already settled a blocking ask_user (avoid dual cards).

    Non-blocking ``question_posted`` or no ask at all → still kickoff. Only a resolved
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


def kickoff_tools(*, show_capabilities: bool) -> list[str]:
    """Tools listed on the kickoff card (empty when AutonomyPolicy hides them)."""
    if not show_capabilities:
        return []
    return sorted(delegation_grantable_tool_names())


async def persist_team_preview(
    tool: DelegateTool,
    checkpoint_id: str,
    plan: RunPlan,
    workers: list[dict[str, Any]],
    required_event,
    *,
    tools: list[str] | None = None,
) -> bool:
    """Capture + persist the durable kickoff frame. Returns True iff saved."""
    if not can_persist_suspension(tool):
        return False
    from agentcore.runtime.suspension import TeamPreviewSuspension, find_tool_call_id
    from agentcore.runtime.suspension_capture import SuspensionCapture, persist_suspension_capture

    tool_list = list(tools or [])

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
            tools=tool_list,
            trace_id=capture.trace_id,
        )

    return await persist_suspension_capture(
        checkpoint_id=checkpoint_id,
        required_event=required_event,
        build_frame=build_frame,
        saver=tool._suspension_saver,  # type: ignore[arg-type]
    )


async def await_team_preview(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    show_capabilities: bool = True,
) -> CheckpointDecision | None:
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
    tools = kickoff_tools(show_capabilities=show_capabilities)
    required = team_preview_required(
        checkpoint_id=checkpoint_id,
        conversation_id=conversation_id,
        workers=workers,
        tools=tools,
    )
    saved = await persist_team_preview(
        tool, checkpoint_id, plan, workers, required, tools=tools
    )
    if saved:
        tool._sink.emit(required)
        tool._pending_pause = True
        logger.info(
            "team_preview.finalized",
            checkpoint_id=checkpoint_id,
            workers=len(workers),
            tools=tools,
        )
        return None

    # D11：删窄兜底——无法落盘则跳过预审放行（非生产无 transcript 等）。
    logger.warning(
        "team_preview.persist_unavailable",
        checkpoint_id=checkpoint_id,
        reason="no_durable_frame",
    )
    return CheckpointDecision.CONTINUE
