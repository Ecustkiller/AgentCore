"""Non-blocking coordinated WaveScheduler host (CEO 协调模式 Phase 2).

Starts the same drive machinery as blocking ``drive``, but returns immediately
after the team is armed; progress posts into :class:`CoordinationSession`.

Mid-coordination secondary ``delegate`` merges into the active session (same
collaboration graph / same event queue) — aligned with classic-path dynamic
delegation — rather than overwriting via :func:`set_active_coordination`.
"""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.runtime.coordination.journal import record_coordination_snapshot
from agentcore.runtime.coordination.session import (
    MAX_COORDINATION_BUDGET,
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    active_coordination,
    coordination_budget_for_batch,
    set_active_coordination,
    should_enter_coordination,
)
from agentcore.runtime.delegate.team_synthesis import worker_output_blurb
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState

DelegateTool = Any

logger = get_logger(__name__)


def _drop_all_completed_events(session: CoordinationSession) -> int:
    """Remove premature ``ALL_COMPLETED`` events after workers are appended mid-flight."""
    dropped = 0
    kept_pending: list[CoordinationEvent] = []
    for ev in session._pending:
        if ev.kind is CoordinationEventKind.ALL_COMPLETED:
            dropped += 1
        else:
            kept_pending.append(ev)
    session._pending = kept_pending
    kept_queued: list[CoordinationEvent] = []
    while True:
        try:
            ev = session._queue.get_nowait()
        except asyncio.QueueEmpty:
            break
        if ev.kind is CoordinationEventKind.ALL_COMPLETED:
            dropped += 1
        else:
            kept_queued.append(ev)
    for ev in kept_queued:
        session._queue.put_nowait(ev)
    return dropped


def _merge_into_active_coordination(
    tool: DelegateTool,
    plan: RunPlan,
    session: CoordinationSession,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None,
    complexity_hint: str,
    call_idx: int,
    completion_criteria: Any,
    coordination: str,
) -> ToolResult:
    """Append ``plan`` workers onto the live session (budget / cancel / arbitration kept)."""
    from agentcore.runtime.delegate.batch_shape import annotate_batch_meta
    from agentcore.runtime.delegate.plan_events import plan_event
    from agentcore.runtime.runs.plan import RunPlan, RunPlanError

    live = session.live_plan
    drive_running = session.drive_task is not None and not session.drive_task.done()
    if live is None and drive_running:
        # Infeasible: background drive owns an unknown plan — do not dual-drive.
        logger.error(
            "coordination.merge_infeasible_no_live_plan",
            execution_id=execution_id,
            total_workers=session.total_workers,
        )
        return annotate_batch_meta(
            ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=(
                    "协调会话缺少活计划指针，无法安全追加队员。"
                    "请等当前团队 all_completed 后再 delegate，或用 replan(add=…) 在波边界追加。"
                ),
            ),
            node_count=len(plan.nodes),
            has_deps=any(n.depends_on for n in plan.nodes),
        )
    if live is None:
        # No live drive: adopt this batch as the live graph and re-arm below.
        live = plan
        session.live_plan = live
        added_nodes = list(plan.nodes)
    else:
        added_nodes = []
        for node in plan.nodes:
            try:
                live.add(node)
            except RunPlanError as exc:
                logger.warning(
                    "coordination.merge_skip_node",
                    execution_id=execution_id,
                    run_id=node.run_id,
                    error=str(exc),
                )
                continue
            added_nodes.append(node)

    if not added_nodes and live is plan:
        added_nodes = list(plan.nodes)

    added_count = len(added_nodes)
    session.total_workers = len(live.nodes)
    # Budget merge: top up by a fresh batch-sized allowance, capped at MAX.
    topup = coordination_budget_for_batch(max(1, added_count))
    session.budget_remaining = min(
        MAX_COORDINATION_BUDGET, session.budget_remaining + topup
    )
    # cancel_ids / pending_arbitrations / resolved_arbitrations / draft retained.

    tool._sink.emit(plan_event(tool, execution_id, live))
    record_coordination_snapshot(session)

    if drive_running:
        # WaveScheduler re-scans ``plan.nodes`` each cycle — appended workers join.
        logger.info(
            "delegate.coordinate_merged",
            execution_id=execution_id,
            added=added_count,
            total_workers=session.total_workers,
            budget_remaining=session.budget_remaining,
            drive="live",
            call=call_idx,
        )
    else:
        # First drive already exited (possibly posted ALL_COMPLETED). Drop that
        # premature terminal event and arm a drive for the newly appended nodes only.
        dropped = _drop_all_completed_events(session)
        session.all_completed_injected = False
        if not session.active:
            session.active = True
        added_plan = RunPlan(
            nodes=list(added_nodes),
            origin=getattr(live, "origin", None) or plan.origin,
        )
        task = asyncio.create_task(
            _background_drive(
                tool,
                added_plan,
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
            name=f"coord-drive-merge-{execution_id[:8]}",
        )
        session.drive_task = task
        logger.info(
            "delegate.coordinate_merged",
            execution_id=execution_id,
            added=added_count,
            total_workers=session.total_workers,
            budget_remaining=session.budget_remaining,
            drive="rearmed",
            dropped_all_completed=dropped,
            call=call_idx,
        )

    roles = [n.role or n.agent_name or n.run_id for n in added_nodes]
    roster = "、".join(roles) if roles else "（无新队员）"
    return annotate_batch_meta(
        ToolResult(
            tool_call_id="",
            success=True,
            output=(
                f"【队员已追加·协调模式】已向当前团队追加 {added_count} 名队员（{roster}）；"
                f"现共 {session.total_workers} 人，仍属同一协作图 / 同一协调会话。\n"
                "取消请求与仲裁态保留；你将继续收到团队事件，全部完成后做最终合成。"
            ),
            effect=ToolEffect.CONTINUE,
        ),
        node_count=added_count,
        has_deps=any(n.depends_on for n in added_nodes),
    )


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

    When an **active** coordination session already exists for ``execution_id``
    (CEO mid-flight secondary ``delegate``), merges workers into that session
    instead of creating a second background drive / overwriting the registry.
    """
    # Secondary delegate while coordinating: merge before the ≥2 gate so a solo
    # append still joins the live team (classic dynamic-delegation parity).
    # Ignore coordinate=false here — a blocking drive beside a live session would
    # dual-drive; opt-out is only meaningful for the *first* arm.
    if session is None:
        existing = active_coordination(execution_id)
        if existing is not None and existing.active and tool._depth == 0 and not finalize:
            return _merge_into_active_coordination(
                tool,
                plan,
                existing,
                execution_id=execution_id,
                seed_completed=seed_completed,
                finalize=finalize,
                seed_notes=seed_notes,
                complexity_hint=complexity_hint,
                call_idx=call_idx,
                completion_criteria=completion_criteria,
                coordination=coordination,
            )

    has_checkpoint = any(bool(n.checkpoint_after) for n in plan.nodes)
    checkpoint_enabled = bool(getattr(tool, "_checkpoint_enabled", False))
    if session is None and not should_enter_coordination(
        coordinate=coordinate,
        worker_count=len(plan.nodes),
        finalize=finalize,
        depth=tool._depth,
        has_checkpoint=has_checkpoint,
        checkpoint_enabled=checkpoint_enabled,
    ):
        if has_checkpoint and checkpoint_enabled:
            logger.info(
                "coordination.skipped",
                reason="checkpoint_after_in_batch",
                execution_id=execution_id,
                nodes=len(plan.nodes),
                checkpoint_nodes=sum(1 for n in plan.nodes if n.checkpoint_after),
            )
        return None

    if session is None:
        session = CoordinationSession(
            execution_id=execution_id,
            total_workers=len(plan.nodes),
            budget_remaining=coordination_budget_for_batch(len(plan.nodes)),
            conversation_id=str(getattr(tool, "_conversation_id", None) or ""),
        )
        session.live_plan = plan
        set_active_coordination(session)
        record_coordination_snapshot(session)
    else:
        if session.live_plan is None:
            session.live_plan = plan
        if not session.conversation_id:
            session.conversation_id = str(
                getattr(tool, "_conversation_id", None) or ""
            )
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
    from agentcore.runtime.delegate.batch_shape import annotate_batch_meta

    return annotate_batch_meta(
        ToolResult(
            tool_call_id="",
            success=True,
            output=(
                f"【团队已启动·协调模式】已派出 {len(plan.nodes)} 名队员（{roster}）。\n"
                "调度在后台继续；你将收到团队事件（worker_completed / note / escalation / "
                "user_interjection / all_completed）。请用 update_synthesis 更新合成草稿；"
                "老板中途插话：相关则图内处置，无关则 queue_user_message 转对话级排队；"
                "全部完成后做最终合成并收口。"
                "单 worker / finalize / 嵌套 lead / 显式 coordinate=false 仍走阻塞等待。"
            ),
            effect=ToolEffect.CONTINUE,
        ),
        node_count=len(plan.nodes),
        has_deps=any(n.depends_on for n in plan.nodes),
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
    from agentcore.runtime.delegate.drive import drive_coordinated

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
            from agentcore.runtime.delegate.supervised import format_boundary_for_ceo

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
