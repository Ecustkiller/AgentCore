"""WaveScheduler drive loop for a delegate plan."""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.runtime.events import batch_metrics as batch_metrics_event
from agentcore.runtime.events import run_progress, team_note_posted
from agentcore.runtime.runs.redirect_queue import RunRedirectRequest, take_redirects
from agentcore.runtime.runs.types import RunSpec
from agentcore.tools.builtin.delegate.accumulate import (
    accumulate_usage,
    collect_citations,
    collect_ledger,
    register_sessions,
)
from agentcore.tools.builtin.delegate.boundary import boundary_hook, checkpoint_active
from agentcore.tools.builtin.delegate.ceo_format import direct_result, format_for_ceo
from agentcore.tools.builtin.delegate.nesting import absorb_children, make_lead_subteam
from agentcore.tools.builtin.delegate.schema import DELEGATE_OUTPUT_LIMIT
from agentcore.tools.builtin.delegate.supervised import (
    SupervisedRun,
    format_boundary_for_ceo,
)
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.types import RunState
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


async def drive(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None = None,
    complexity_hint: str = "standard",
) -> ToolResult:
    """Run ``plan`` through the WaveScheduler and fold workers' products into a CEO ToolResult."""
    tool._pending_boundary = None
    tool._pending_pause = False
    from agentcore.runtime.costing import usage_metadata
    from agentcore.runtime.runs import (
        DEFAULT_MAX_PARALLEL,
        BatchMetrics,
        BoundaryReason,
        RunPhase,
        WaveScheduler,
        build_agent_executor,
    )
    from agentcore.runtime.runs.notewall import NoteWall
    from agentcore.tools.builtin.delegate.seed_notes import seed_note_wall

    # 团队便签墙 (§2.2 通 / §2.3 合·对账): own this batch's wall here so the CEO finalize can fold
    # its outstanding 决定 / 认领 into 语义边界对账. Passed into the executor (workers post / read /
    # amend on it) AND stashed on the tool so format_for_ceo reaches it on BOTH finalize paths
    # (normal 终态 below + replan(stop) finalize_stopped). One wall per drive call = per fan-out
    # batch, matching the wall's existing per-batch visibility scope.
    # light 委派跳过便签墙初始化（build_agent_executor 在 note_wall=None 时会自建空墙，开销可忽略）。
    if complexity_hint == "light":
        note_wall = None
        tool._note_wall = None
    else:
        prev_wall = tool._note_wall
        note_wall = NoteWall()
        if prev_wall is not None and seed_completed is None:
            inherited = note_wall.inherit(prev_wall.active_notes())
            for note in inherited:
                tool._sink.emit(
                    team_note_posted(
                        execution_id=execution_id,
                        note_id=note.note_id,
                        run_id=note.run_id,
                        agent_id=note.agent_id,
                        role=note.role,
                        kind=note.kind,
                        text=note.text,
                        ts=note.ts,
                        source="inherited",
                    )
                )
            if inherited:
                logger.info(
                    "delegate.inherit_notes",
                    count=len(inherited),
                    execution_id=execution_id,
                )
        tool._note_wall = note_wall
        if seed_notes and seed_completed is None:
            seed_note_wall(
                note_wall,
                seed_notes,
                sink=tool._sink,
                execution_id=execution_id,
            )

    worker_gate = (
        tool._approval_gate if tool._base_tool_context.backend.location == "local" else None
    )

    executor = build_agent_executor(
        plan=plan,
        llm=tool._llm,
        tools=tool._tools,
        sink=tool._sink,
        base_tool_context=tool._base_tool_context,
        profile_set=tool._profile_set,
        system_prompt=tool._system_prompt,
        user_message=tool._user_message,
        execution_id=execution_id,
        approval_gate=worker_gate,
        delegate_factory=lambda captain_run_id, captain_depth: make_lead_subteam(
            tool, captain_run_id, captain_depth
        ),
        interaction_bridge=tool._registry,
        escalation_timeout=tool._checkpoint_timeout_seconds,
        escalation_armed=checkpoint_active(tool),
        note_wall=note_wall,
        collaboration=len(plan.nodes) > 1,
        team_brief=tool._team_brief,
    )

    total = len(plan.nodes)

    # Phase 2a redirect: single-run cancel + cold re-run
    _cancel_ids: set[str] = set()
    _redirect_feedback: dict[str, RunRedirectRequest] = {}

    def _cancel_run_ids() -> frozenset[str]:
        for redir in take_redirects(execution_id):
            _cancel_ids.add(redir.run_id)
            _redirect_feedback[redir.run_id] = redir
            logger.info(
                "delegate.run_redirect_accepted",
                execution_id=execution_id,
                run_id=redir.run_id,
                feedback_preview=redir.feedback[:120],
            )
        return frozenset(_cancel_ids)

    def _progress(completed) -> None:
        nonlocal total
        done = sum(1 for s in completed.values() if s.phase is RunPhase.COMPLETED)
        tool._sink.emit(run_progress(done, total))

        # Phase 2a cold re-run: if a cancelled node has redirect feedback, add a
        # replacement node to the plan with the user's steer.
        for run_id, state in list(completed.items()):
            if state.phase is RunPhase.CANCELLED and run_id in _redirect_feedback:
                original = plan.by_id(run_id)
                redir = _redirect_feedback.pop(run_id)
                if original is not None:
                    new_id = f"{run_id}_redir"
                    new_spec = RunSpec(
                        run_id=new_id,
                        task=original.task,
                        kind=original.kind,
                        agent_id=new_id,
                        agent_name=original.agent_name,
                        role=original.role,
                        objective=original.objective,
                        system_prompt_supplement=original.system_prompt_supplement,
                        tools=original.tools,
                        model_preference=original.model_preference,
                        model=original.model,
                        thinking=original.thinking,
                        reasoning_effort=original.reasoning_effort,
                        deliverable=original.deliverable,
                        stance=original.stance,
                        group=original.group,
                        round=original.round,
                        depends_on=original.depends_on,
                        parent_run_id=original.parent_run_id,
                        depth=original.depth,
                        can_delegate=original.can_delegate,
                        policy=original.policy,
                        sibling_summary=original.sibling_summary,
                        steer=redir.feedback,
                    )
                    plan.add(new_spec)
                    total = len(plan.nodes)
                    logger.info(
                        "delegate.run_redirect_rerun",
                        execution_id=execution_id,
                        cancelled_run_id=run_id,
                        new_run_id=new_id,
                        feedback_preview=redir.feedback[:120],
                    )

    if complexity_hint == "light":
        on_boundary = None
    else:
        on_boundary = (
            boundary_hook(tool, plan)
            if (
                checkpoint_active(tool)
                or any(n.bind_after_deps for n in plan.nodes)
                or any(n.depends_on for n in plan.nodes)
            )
            else None
        )
    batch_metrics: list[BatchMetrics] = []
    results = await WaveScheduler(tool._max_parallel or DEFAULT_MAX_PARALLEL).run(
        plan,
        executor,
        seed_completed=seed_completed,
        cancel_run_ids=_cancel_run_ids,
        on_progress=_progress,
        on_boundary=on_boundary,
        metrics_sink=batch_metrics,
    )
    if batch_metrics:
        m = batch_metrics[0]
        logger.info(
            "delegate.completed",
            call=tool._calls,
            hint=complexity_hint,
            nodes=m.nodes,
            width=m.width,
            peak=m.peak_running,
            wall_ms=m.wall_ms,
            busy_ms=m.busy_ms,
            avg_parallelism=round(m.busy_ms / m.wall_ms, 2) if m.wall_ms else 0.0,
            slot_starved=m.slot_starved,
            completed=m.completed,
            failed=m.failed,
            skipped=m.skipped,
            # 受监督波循环埋点 (执行引擎架构设计.md §受监督的波循环): boundary fires this segment +
            # scope 信号占比 (derived from raw counts, mirroring avg_parallelism).
            bind=m.bind_boundaries,
            scope=m.scope_boundaries,
            checkpoint=m.checkpoint_boundaries,
            escalations=m.escalations,
            scope_ratio=round(m.scope_escalations / m.escalations, 2) if m.escalations else 0.0,
        )
        # 协作质量 tally (学·度量 §2.5): fold this batch's drift + escalation signals into the
        # turn-level roll-up on the accumulator (rolls up to the captain via absorb_children).
        tool._acc.collab["scope_signals"] += m.scope_escalations
        tool._acc.collab["escalations"] += m.escalations
        # 深层诊断指标 (前端UX设计.md §十): surface the scheduler snapshot to the client so
        # 诊断模式 shows it in run detail (journaled → replays on reload). Whole-batch verbatim
        # — the host already logged it; this just also hands it to the UI fold.
        tool._sink.emit(
            batch_metrics_event(execution_id=execution_id, metrics=dataclasses.asdict(m))
        )

    # 挂起即收口 (②): the checkpoint boundary persisted a resume frame and YIELDed (soft
    # pause). End the turn here with a SUSPEND ToolResult — the engine maps it to
    # FinishReason.PAUSED, leaves the delegate call pending (no result), and the persist
    # tail parks the turn (the frame is the record). The已完成 workers' usage / ledger /
    # citations are NOT folded here: they ride the durable frame's ``completed`` and bill
    # on the cold resume drive — matching the disconnect→resume path this collapses onto.
    if tool._pending_pause:
        tool._pending_pause = False
        logger.info("delegate.paused", call=tool._calls, completed=len(results))
        return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)

    if tool._pending_boundary is not None:
        reason, nodes = tool._pending_boundary
        tool._pending_boundary = None
        # 单一事实源 (P5 持久化): a SCOPE yield marked the deviating nodes' escalations
        # ``consumed`` IN PLACE (wave.py). Re-journal their terminal RunState so
        # ``completed_from_journal`` rebuilds the resume seed WITH ``consumed`` — else a
        # durable re-drive (a later checkpoint pause + resume of the same plan) would
        # re-fire an already-handled SCOPE boundary. Last-write-wins per run_id makes the
        # refreshed message_final supersede the pre-consumption one.
        if reason is BoundaryReason.SCOPE:
            from agentcore.runtime.facts import record_turn_fact
            from agentcore.runtime.runs.serialize import run_final_fact

            for node in nodes:
                state = results.get(node.run_id)
                if state is not None:
                    record_turn_fact(run_final_fact(node.run_id, state))
        tool._supervised = SupervisedRun(
            plan=plan,
            completed=dict(results),
            execution_id=execution_id,
            finalize=finalize,
            reason=reason,
            boundary_run_ids=[n.run_id for n in nodes],
        )
        # 协作质量 tally (学·度量 §2.5, 首计划存活): a supervised boundary handed control back
        # to the captain mid-plan — the opening plan did not run start-to-finish untouched.
        tool._acc.collab["boundary_yields"] += 1
        logger.info(
            "delegate.yielded",
            call=tool._calls,
            reason=reason.value,
            boundary=[n.run_id for n in nodes],
            completed=len(results),
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=format_boundary_for_ceo(tool, reason, plan, results, nodes),
            output_limit=DELEGATE_OUTPUT_LIMIT,
        )

    # Partial failure: all nodes terminal but some FAILED / SKIPPED — stash the plan so the
    # CEO can replan(add=...) replacement nodes on the SAME DAG (not a fresh delegate).
    # Usage / ledger / citations fold on the resume or dispose path (same as boundary yield).
    # Only failures from THIS drive segment count — nodes already FAILED/SKIPPED in
    # ``seed_completed`` (a replan resume) must not re-trigger stash.
    seeded_ids = set(seed_completed or ())
    failed_nodes = [
        n
        for n in plan.nodes
        if (st := results.get(n.run_id)) is not None
        and st.phase in (RunPhase.FAILED, RunPhase.SKIPPED)
        and n.run_id not in seeded_ids
    ]
    if failed_nodes and tool._supervised is None:
        tool._supervised = SupervisedRun(
            plan=plan,
            completed=dict(results),
            execution_id=execution_id,
            finalize=finalize,
            reason=BoundaryReason.SCOPE,
            boundary_run_ids=[n.run_id for n in failed_nodes],
        )
        logger.info(
            "delegate.partial_failure_stashed",
            call=tool._calls,
            failed=[n.run_id for n in failed_nodes],
            completed=len(results),
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=format_for_ceo(tool, plan, results),
            output_limit=DELEGATE_OUTPUT_LIMIT,
        )

    # §十一 来源卡接入 (方案①, 法律垂直场景设计.md): snapshot the turn-accumulated sources
    # BEFORE folding this call's workers in, so the slice below is exactly THIS delegate call's
    # NEW (deduped) web sources — including any nested sub-team absorbed just after. Carrying
    # them on the ToolResult lets the CEO-path execute_tools number them into the turn's source
    # cards AND fold each [n]=url back into THIS tool message, so the CEO can cite a worker-found
    # 法条 by a card-aligned [n] (Gap A). merge_citations dedups by url, so the turn-close
    # backstop merge (pipeline.run / resume.finish) re-folds the same sources as a no-op — one
    # numbering source, stable card indices across calls, no reconciliation patch.
    citations_before = len(tool._acc.citations)
    call_usage = accumulate_usage(tool, results)
    collect_ledger(tool, plan, results)
    collect_citations(tool, results)
    registered = register_sessions(tool, plan, results)
    if tool._session_saver is not None:
        for session in registered:
            await tool._session_saver(session)
    absorb_children(tool)
    new_citations = tool._acc.citations[citations_before:]

    if finalize and len(plan.nodes) == 1:
        only = results.get(plan.nodes[0].run_id)
        if only and only.phase is RunPhase.COMPLETED and only.content.strip():
            return direct_result(tool, only)

    output = format_for_ceo(tool, plan, results)
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        output_limit=DELEGATE_OUTPUT_LIMIT,
        metadata=usage_metadata(call_usage),
        citations=new_citations or None,
    )
