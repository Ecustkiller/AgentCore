"""Non-blocking coordinated WaveScheduler host (CEO 协调模式 Phase 2).

Starts the same drive machinery as blocking ``drive``, but returns immediately
after the team is armed; progress posts into :class:`CoordinationSession`.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.runtime.coordination.journal import record_coordination_snapshot
from agentcore.runtime.coordination.session import (
    DEFAULT_COORDINATION_BUDGET,
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    set_active_coordination,
    should_enter_coordination,
)
from agentcore.tools.builtin.delegate.team_synthesis import worker_output_blurb
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


def try_start_coordination(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None,
    complexity_hint: str,
    call_idx: int,
    completion_criteria: Any,
    coordinate: bool,
    coordination: str = "none",
    session: CoordinationSession | None = None,
) -> ToolResult | None:
    """If the coordinate gate passes, arm a background drive and return the start result.

    Returns ``None`` when the caller should fall through to blocking ``drive``.
    Pass an existing ``session`` on ask_user resume to preserve draft / budget.
    """
    if session is None and not should_enter_coordination(
        coordinate=coordinate,
        worker_count=len(plan.nodes),
        finalize=finalize,
        depth=tool._depth,
    ):
        return None

    if session is None:
        session = CoordinationSession(
            execution_id=execution_id,
            total_workers=len(plan.nodes),
            budget_remaining=DEFAULT_COORDINATION_BUDGET,
        )
        set_active_coordination(session)
        record_coordination_snapshot(session)
    else:
        set_active_coordination(session)

    task = asyncio.create_task(
        _background_drive(
            tool,
            plan,
            execution_id=execution_id,
            seed_completed=seed_completed,
            finalize=finalize,
            seed_notes=seed_notes,
            complexity_hint=complexity_hint,
            coordination=coordination,
            call_idx=call_idx,
            completion_criteria=completion_criteria,
            session=session,
        ),
        name=f"coord-drive-{execution_id[:8]}",
    )
    session.drive_task = task

    roles = [n.role or n.agent_name or n.run_id for n in plan.nodes]
    roster = "、".join(roles)
    logger.info(
        "delegate.coordinate_started",
        execution_id=execution_id,
        nodes=len(plan.nodes),
        call=call_idx,
        resumed=seed_completed is not None,
    )
    return ToolResult(
        tool_call_id="",
        success=True,
        output=(
            f"【团队已启动·协调模式】已派出 {len(plan.nodes)} 名队员（{roster}）。\n"
            "调度在后台继续；你将收到团队事件（worker_completed / note / escalation / "
            "all_completed）。请用 update_synthesis 更新合成草稿；"
            "全部完成后做最终合成并收口。"
            "单 worker / finalize / 嵌套 lead / 显式 coordinate=false 仍走阻塞等待。"
        ),
        effect=ToolEffect.CONTINUE,
    )


async def _background_drive(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None,
    complexity_hint: str,
    call_idx: int,
    completion_criteria: Any,
    session: CoordinationSession,
    coordination: str = "none",
) -> None:
    """Run blocking drive semantics, posting coordination events along the way."""
    from agentcore.tools.builtin.delegate.drive import drive_coordinated

    try:
        result = await drive_coordinated(
            tool,
            plan,
            execution_id=execution_id,
            seed_completed=seed_completed,
            finalize=finalize,
            seed_notes=seed_notes,
            complexity_hint=complexity_hint,
            coordination=coordination,
            call_idx=call_idx,
            completion_criteria=completion_criteria,
            session=session,
        )
        # Boundary / pause results surface as coordination events (CEO still alive).
        # drive 在 session 路径上故意保留 ``_pending_*``（见 drive.py），此处消费后清掉。
        if tool._pending_pause:
            tool._pending_pause = False
            session.post(
                CoordinationEvent(
                    kind=CoordinationEventKind.BOUNDARY_YIELD,
                    payload={"reason": "checkpoint", "brief": "计划在 checkpoint 暂停"},
                )
            )
        elif tool._pending_boundary is not None:
            reason, nodes = tool._pending_boundary
            tool._pending_boundary = None
            from agentcore.tools.builtin.delegate.supervised import format_boundary_for_ceo

            # Prefer the brief drive already formatted (includes completed worker output);
            # fall back to a fresh format when drive returned empty.
            brief = (result.output if result is not None and result.output else "") or (
                format_boundary_for_ceo(tool, reason, plan, {}, nodes)
            )
            session.post(
                CoordinationEvent(
                    kind=CoordinationEventKind.BOUNDARY_YIELD,
                    payload={
                        "reason": reason.value,
                        "brief": brief[:2000],
                        "boundary_run_ids": [n.run_id for n in nodes],
                    },
                )
            )
        elif result is not None and result.success:
            # Terminal batch — all_completed already posted inside drive_coordinated.
            pass
    except asyncio.CancelledError:
        logger.info("delegate.coordinate_cancelled", execution_id=execution_id)
        raise
    except Exception:  # noqa: BLE001 — never kill the CEO loop via background task
        logger.exception("delegate.coordinate_failed", execution_id=execution_id)
        session.post(
            CoordinationEvent(
                kind=CoordinationEventKind.ALL_COMPLETED,
                payload={
                    "completed": len(session.completed_run_ids),
                    "total": session.total_workers,
                    "error": "后台调度异常结束，请基于已有结果收口。",
                },
            )
        )
    finally:
        record_coordination_snapshot(session)


def post_worker_progress(
    session: CoordinationSession,
    plan: RunPlan,
    completed: dict[str, RunState],
    *,
    sink: Any,
    execution_id: str,
    previously: set[str],
) -> set[str]:
    """Post coordination events for newly terminal workers (preview already emitted)."""
    from agentcore.runtime.coordination.bridge import post_completed_escalations
    from agentcore.runtime.runs.types import RunPhase

    newly = set(completed) - previously
    terminal: set[str] = set()
    for run_id in newly:
        state = completed[run_id]
        if state.phase not in (
            RunPhase.COMPLETED,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
            RunPhase.SKIPPED,
        ):
            continue
        terminal.add(run_id)
        node = plan.by_id(run_id)
        role = (node.role if node else None) or run_id
        session.mark_worker_completed(run_id)
        session.post(
            CoordinationEvent(
                kind=CoordinationEventKind.WORKER_COMPLETED,
                payload={
                    "run_id": run_id,
                    "role": role,
                    "status": state.phase.value,
                    "summary": worker_output_blurb(state),
                },
            )
        )
    # Safety net: transcript-harvested escalations that missed the live on_escalate bridge.
    if terminal:
        post_completed_escalations(session, plan, completed, newly=terminal)
    return set(completed)
