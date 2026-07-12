"""WaveScheduler drive loop for a delegate plan."""

from __future__ import annotations

import dataclasses
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import batch_metrics as batch_metrics_event
from agentcore.runtime.events import run_progress, run_skipped, team_note_posted
from agentcore.runtime.runs.redirect_queue import RunRedirectRequest, take_redirects
from agentcore.runtime.runs.types import RunSpec, RunState
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
from agentcore.tools.builtin.delegate.team_synthesis import (
    maybe_emit_team_synthesis_preview,
)
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.session import RunSession
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


async def _team_preview_before_workers(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    finalize: bool,
    complexity_hint: str,
    seed_completed: dict[str, RunState] | None,
    call_idx: int,
) -> ToolResult | None:
    """Hang for the kickoff card (计划+能力) before any worker / coordinate fork.

    Returns an early ToolResult (SUSPEND / stop) or None to proceed. Under
    AutonomyPolicy.full_auto, skips the card entirely and silently marks a
    delegation grant for later application.
    """
    if seed_completed is not None or complexity_hint == "light" or tool._depth != 0:
        return None
    from agentcore.core.types import AutonomyPolicy
    from agentcore.runtime.sandbox_approval import worker_gate_applies
    from agentcore.tools.builtin.delegate.preview import (
        await_team_preview,
        needs_capability_auth,
        should_kickoff,
        should_preview_plan,
        skip_after_confirmed_ask,
    )

    autonomy = getattr(tool, "_autonomy_policy", None) or AutonomyPolicy.FIRST_GRANT
    local_gate = worker_gate_applies(tool._base_tool_context.backend)
    plan_preview = should_preview_plan(plan, finalize=finalize)
    if not should_kickoff(
        plan, finalize=finalize, local_gate=local_gate, autonomy=autonomy
    ):
        # full_auto + local: silent grant (plan half also released under full_auto).
        if (
            local_gate
            and autonomy is AutonomyPolicy.FULL_AUTO
            and tool._approval_gate is not None
        ):
            tool._auto_grant_pending = True  # type: ignore[attr-defined]
        return None
    # Plan half skipped after confirmed ask; capability half may still need a card.
    # If only plan would have shown, skip entirely (legacy dual-card avoidance).
    if (
        skip_after_confirmed_ask(tool)
        and not needs_capability_auth(local_gate=local_gate, autonomy=autonomy)
        and plan_preview
    ):
        return None
    show_capabilities = needs_capability_auth(local_gate=local_gate, autonomy=autonomy)
    preview_decision = await await_team_preview(
        tool, plan, show_capabilities=show_capabilities
    )
    if tool._pending_pause:
        logger.info("delegate.team_preview_paused", call=call_idx, nodes=len(plan.nodes))
        return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)
    if preview_decision is CheckpointDecision.STOP:
        from agentcore.tools.builtin.delegate.supervised import finalize_stopped

        return await finalize_stopped(tool, plan, {})
    return None


async def drive(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None = None,
    complexity_hint: str = "standard",
    coordination: str = "none",
    call_idx: int | None = None,
    completion_criteria: Any = None,
    coordinate: bool = True,
    session: Any = None,
) -> ToolResult:
    """Run ``plan`` through the WaveScheduler and fold workers' products into a CEO ToolResult.

    When ``coordinate`` is true (default) and the gate passes (≥2 workers, root CEO,
    not finalize), starts a background scheduler and returns immediately. Pass
    ``coordinate=False`` for classic blocking. Pass ``session`` only from the
    background task (:func:`drive_coordinated`).

    ``team_preview`` runs on the CEO path **before** the coordinate fork so a durable
    pause yields ``SUSPEND`` on the main loop (``message_end(paused)``), not only inside
    the background task.
    """
    tool._pending_boundary = None
    tool._pending_pause = False
    # 本批次定格的委派序号（见 DelegateTool.execute）：同回合并发委派共享 tool._calls，完成侧
    # 日志必须用调用时定格的值而非活动计数器。resume / checkpoint 重跑时只有单个委派在飞，回退
    # 到活动计数器即可。
    call_idx = call_idx if call_idx is not None else tool._calls

    # 团队预审：必须在 coordinate fork 之前（CEO 主路径）。挂起 → SUSPEND 收口；
    # 用户开做/调整后续跑再臂后台。后台 drive_coordinated 带 session，跳过本闸。
    if session is None:
        preview_early = await _team_preview_before_workers(
            tool,
            plan,
            finalize=finalize,
            complexity_hint=complexity_hint,
            seed_completed=seed_completed,
            call_idx=call_idx,
        )
        if preview_early is not None:
            return preview_early

    # CEO 协调模式：默认非阻塞臂（solo / finalize / depth>0 / 显式 false 由 gate 拦下）。
    if session is None and coordinate:
        from agentcore.runtime.coordination.host import try_start_coordination

        started = try_start_coordination(
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
            coordinate=coordinate,
        )
        if started is not None:
            return started

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
    # 存在性由 CEO 的 coordination 声明（缺省 none）；light 隐含 none。collaboration 仍走既有开关。
    collaboration = len(plan.nodes) > 1 and coordination == "wall"
    if not collaboration:
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

    from agentcore.runtime.sandbox_approval import worker_gate_applies

    worker_gate = (
        tool._approval_gate if worker_gate_applies(tool._base_tool_context.backend) else None
    )

    cold_executor = build_agent_executor(
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
        collaboration=collaboration,
        team_brief=tool._team_brief,
    )

    async def _continuation_aware_executor(spec: RunSpec, completed: dict) -> RunState:
        """带 continue_from_run_id 的节点走续写；其余冷开局。"""
        if spec.continue_from_run_id:
            from agentcore.tools.builtin.delegate.continuation import run_continuation

            return await run_continuation(
                tool,
                spec,
                completed,
                execution_id=execution_id,
                approval_gate=worker_gate,
            )
        return await cold_executor(spec, completed)

    executor = _continuation_aware_executor
    # Phase 3: per-worker timeout notify (CEO decides; never auto-cancel).
    if session is not None:
        from agentcore.runtime.coordination.bridge import wrap_executor_with_timeouts

        executor = wrap_executor_with_timeouts(executor, session)

    total = len(plan.nodes)

    # 跑一半改方向：单人 cancel + 热优先 continue_run / 冷诚实 _redir 接手
    _cancel_ids: set[str] = set()
    _redirect_feedback: dict[str, RunRedirectRequest] = {}
    # Hot-path continuation states keyed by continuation run_id.
    _hot_revision_states: dict[str, RunState] = {}
    # In-drive author sessions (run_id → latest draft + recall_count) so a second
    # redirect on the same cancelled worker increments ``_revN`` even without a
    # turn-level SessionStore; synced to ``tool._session_store`` when present.
    _author_sessions: dict[str, RunSession] = {}

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
        # Coordination cancel_worker merges into the same cancel set.
        if session is not None:
            _cancel_ids.update(session.cancel_run_ids())
        return frozenset(_cancel_ids)

    def _cold_fallback(original: RunSpec, redir: RunRedirectRequest) -> str:
        """Append a same-role handoff node (``_redir`` + replaces_run_id + steer)."""
        # Unique handoff id if the same author cold-falls more than once this drive.
        base = f"{original.run_id}_redir"
        new_id = base
        n = 2
        while plan.by_id(new_id) is not None:
            new_id = f"{base}{n}"
            n += 1
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
            replaces_run_id=original.run_id,
            steer=redir.feedback,
        )
        plan.add(new_spec)
        return new_id

    async def _try_hot_continue(
        original: RunSpec,
        state: RunState,
        redir: RunRedirectRequest,
    ) -> bool:
        """Salvage → continue_run. True on successful hot path; False → caller cold-falls.

        Continuation ids follow the same 唤回闸 as CEO ``continue_from``:
        ``{run_id}_rev{recall_count+1}`` with ``continues_run_id`` = session root on the wire.
        A second redirect on the same author continues from the author session so
        numbering increments (``_rev2``, …) instead of minting a duplicate ``_rev1``.
        """
        from agentcore.runtime.runs import RunSession, continue_run
        from agentcore.runtime.runs.constants import DEFAULT_RECALL_LIMIT
        from agentcore.runtime.runs.salvage import is_continuable_transcript
        from agentcore.runtime.runs.types import ContextBlock

        existing = _author_sessions.get(original.run_id)
        if existing is None and tool._session_store is not None:
            existing = tool._session_store.get(original.run_id)
        if existing is not None and existing.transcript:
            session = RunSession(
                run_id=original.run_id,
                spec=existing.spec,
                transcript=list(existing.transcript),
                content=existing.content or "",
                recall_count=existing.recall_count,
                partial=existing.partial,
            )
        elif is_continuable_transcript(state.transcript):
            session = RunSession(
                run_id=original.run_id,
                spec=original,
                transcript=list(state.transcript),
                content=state.content or "",
                recall_count=0,
                partial=True,
            )
        else:
            return False
        if session.recall_count >= DEFAULT_RECALL_LIMIT:
            logger.info(
                "delegate.run_redirect_hot_capped",
                execution_id=execution_id,
                run_id=original.run_id,
                recall_count=session.recall_count,
            )
            return False
        continuation_run_id = f"{original.run_id}_rev{session.recall_count + 1}"
        context_blocks = [
            ContextBlock(
                channel="continuation",
                heading="本次改方向（用户立即改此人）",
                body=redir.feedback,
            )
        ]
        try:
            rev_state = await continue_run(
                session=session,
                feedback=redir.feedback,
                continuation_run_id=continuation_run_id,
                llm=tool._llm,
                tools=tool._tools,
                sink=tool._sink,
                base_tool_context=tool._base_tool_context,
                execution_id=execution_id,
                profile_set=tool._profile_set,
                approval_gate=worker_gate,
                context_blocks=context_blocks,
                parent_run_id=original.parent_run_id,
            )
        except Exception:  # noqa: BLE001 — hot fail → cold fallback
            logger.exception(
                "delegate.run_redirect_hot_failed",
                execution_id=execution_id,
                run_id=original.run_id,
            )
            return False
        if rev_state.phase is not RunPhase.COMPLETED or not (rev_state.content or "").strip():
            logger.info(
                "delegate.run_redirect_hot_empty",
                execution_id=execution_id,
                run_id=original.run_id,
                phase=rev_state.phase.value,
            )
            return False
        committed = RunSession(
            run_id=original.run_id,
            spec=original,
            transcript=list(rev_state.transcript) or list(session.transcript),
            content=rev_state.content,
            recall_count=session.recall_count + 1,
            partial=False,
        )
        _author_sessions[original.run_id] = committed
        if tool._session_store is not None:
            tool._session_store.put(committed)
        if tool._session_saver is not None:
            await tool._session_saver(committed)
        _hot_revision_states[continuation_run_id] = rev_state
        tool.note_continuation(continuation_run_id)
        logger.info(
            "delegate.run_redirect_hot",
            execution_id=execution_id,
            cancelled_run_id=original.run_id,
            continuation_run_id=continuation_run_id,
            recall_count=committed.recall_count,
            feedback_preview=redir.feedback[:120],
        )
        return True

    _coord_seen: set[str] = set(seed_completed or ())

    async def _progress(completed) -> None:
        nonlocal total, _coord_seen
        # 单个 run 完成即登记现场，使同批「depends_on X + continue_from X」成立。
        from agentcore.tools.builtin.delegate.continuation import register_completed_session

        newly_registered: list = []
        for rid, st in completed.items():
            sess = register_completed_session(
                tool, plan, rid, st, author_sessions=_author_sessions
            )
            if sess is not None:
                newly_registered.append(sess)
        if tool._session_saver is not None:
            for sess in newly_registered:
                await tool._session_saver(sess)

        done = sum(1 for s in completed.values() if s.phase is RunPhase.COMPLETED)
        # Count successful hot revisions toward progress (they are not plan nodes).
        done += sum(
            1 for s in _hot_revision_states.values() if s.phase is RunPhase.COMPLETED
        )
        tool._sink.emit(run_progress(done, total))
        # CEO 协调模式 Phase 1：旁路团队进展摘要（≥2 worker；不阻塞 redirect 排空）。
        maybe_emit_team_synthesis_preview(
            tool._sink, plan, completed, execution_id=execution_id
        )
        # Phase 2: post worker_completed into the coordination queue (background drive).
        if session is not None:
            from agentcore.runtime.coordination.host import post_worker_progress

            _coord_seen = post_worker_progress(
                session,
                plan,
                dict(completed),
                sink=tool._sink,
                execution_id=execution_id,
                previously=_coord_seen,
            )

        # Apply redirects for CANCELLED authors. Loop: a hot continue may enqueue the
        # next「立即改此人」before returning; without a re-drain that steer would sit
        # until wave exit and be mis-classified as ignored (especially solo workers
        # with no sibling completion to re-enter on_progress).
        while True:
            for redir in take_redirects(execution_id):
                _cancel_ids.add(redir.run_id)
                _redirect_feedback[redir.run_id] = redir
            applied = False
            for run_id, redir in list(_redirect_feedback.items()):
                state = completed.get(run_id)
                if state is None or state.phase is not RunPhase.CANCELLED:
                    continue
                original = plan.by_id(run_id)
                _redirect_feedback.pop(run_id)
                if original is None:
                    continue
                applied = True
                hot_ok = await _try_hot_continue(original, state, redir)
                if hot_ok:
                    continue
                new_id = _cold_fallback(original, redir)
                total = len(plan.nodes)
                logger.info(
                    "delegate.run_redirect_cold",
                    execution_id=execution_id,
                    cancelled_run_id=run_id,
                    new_run_id=new_id,
                    feedback_preview=redir.feedback[:120],
                )
            if not applied:
                break
        # Refresh progress after hot/cold follow-ups (revision nodes / new _redir).
        done = sum(1 for s in completed.values() if s.phase is RunPhase.COMPLETED)
        done += sum(
            1 for s in _hot_revision_states.values() if s.phase is RunPhase.COMPLETED
        )
        tool._sink.emit(run_progress(done, total))
        maybe_emit_team_synthesis_preview(
            tool._sink, plan, completed, execution_id=execution_id
        )

    # light 与 depends_on / bind_after_deps / checkpoint_after 并存时忽略 light：
    # 不得据 light 关掉波边界（否则晚绑定节点会带占位 role/task 直接跑）。
    has_dag_boundary = any(
        n.bind_after_deps or n.depends_on or n.checkpoint_after for n in plan.nodes
    )
    if complexity_hint == "light" and not has_dag_boundary:
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
    # Phase 3: under coordination, SCOPE/dep escalations → CEO event queue (PROCEED),
    # not wave-boundary YIELD. CHECKPOINT skips durable plan_review (boundary_hook →
    # ``_pending_boundary`` only); BIND still uses the base hook when present.
    if session is not None:
        from agentcore.runtime.coordination.bridge import coordination_boundary_hook

        # Always wire a hook so SCOPE can fire even when the plan has no depends_on /
        # checkpoint markers (parallel fan-out with escalate kind=scope).
        on_boundary = coordination_boundary_hook(session, on_boundary)
    batch_metrics: list[BatchMetrics] = []

    # Kickoff grant: issued by resume (continue/adjust) or full_auto auto-grant.
    # Hot-path ``request_delegation_authorization`` retired — capability auth lives
    # on the durable开工卡 (team_preview) or is silent under full_auto.
    delegation_started = False
    if worker_gate is not None and seed_completed is None:
        from agentcore.core.types import AutonomyPolicy

        auto = bool(getattr(tool, "_auto_grant_pending", False))
        already = worker_gate.has_delegation_grant(execution_id)
        autonomy = getattr(tool, "_autonomy_policy", None) or AutonomyPolicy.FIRST_GRANT
        if auto or already or autonomy is AutonomyPolicy.FULL_AUTO:
            if not already:
                worker_gate.grant_delegation(execution_id)
            tool._auto_grant_pending = False  # type: ignore[attr-defined]
            delegation_started = True
        elif worker_gate.has_delegation_grant(execution_id):
            delegation_started = True

    try:
        results = await WaveScheduler(tool._max_parallel or DEFAULT_MAX_PARALLEL).run(
            plan,
            executor,
            seed_completed=seed_completed,
            cancel_run_ids=_cancel_run_ids,
            on_progress=_progress,
            on_boundary=on_boundary,
            on_skipped=lambda rid, aid, reason: tool._sink.emit(
                run_skipped(rid, aid, reason=reason)
            ),
            metrics_sink=batch_metrics,
        )
    finally:
        if delegation_started and worker_gate is not None:
            worker_gate.revoke_delegation(execution_id)

    # Fold successful hot-redirect revisions into the result map (usage / CEO format /
    # session roster). They are not plan nodes — continue_run already emitted their wire.
    results.update(_hot_revision_states)

    # Post-wave drain: a redirect that landed while the last hot continue was running
    # (or after the final on_progress) still targets a CANCELLED author — apply it
    # here so a second「立即改此人」is not mis-classified as ignored. Prefer hot;
    # cold appends a ``_redir`` and runs one more scheduler pass for that handoff only.
    post_wave_cold = False
    for redir in take_redirects(execution_id):
        _redirect_feedback[redir.run_id] = redir
    for run_id, redir in list(_redirect_feedback.items()):
        state = results.get(run_id)
        if state is None or state.phase is not RunPhase.CANCELLED:
            continue
        original = plan.by_id(run_id)
        _redirect_feedback.pop(run_id)
        if original is None:
            continue
        hot_ok = await _try_hot_continue(original, state, redir)
        if hot_ok:
            continue
        new_id = _cold_fallback(original, redir)
        post_wave_cold = True
        logger.info(
            "delegate.run_redirect_cold",
            execution_id=execution_id,
            cancelled_run_id=run_id,
            new_run_id=new_id,
            feedback_preview=redir.feedback[:120],
        )
    if post_wave_cold:
        more = await WaveScheduler(tool._max_parallel or DEFAULT_MAX_PARALLEL).run(
            plan,
            executor,
            seed_completed=results,
            cancel_run_ids=_cancel_run_ids,
            on_progress=_progress,
            on_boundary=None,
            on_skipped=lambda rid, aid, reason: tool._sink.emit(
                run_skipped(rid, aid, reason=reason)
            ),
        )
        results.update(more)
    results.update(_hot_revision_states)

    # 跑一半改方向 · 忽略路径 (run_redirect Step 4): a redirect whose target was already
    # terminal *and not CANCELLED* (completed/failed) when drained never became a
    # cancel+hot/cold apply — record each once so the run detail can surface「改方向未生效」
    # and offer an explicit accept. Audit-only (no new SSE event).
    ignored_redirects: dict[str, RunRedirectRequest] = dict(_redirect_feedback)
    for redir in take_redirects(execution_id):
        ignored_redirects.setdefault(redir.run_id, redir)
    if ignored_redirects:
        from agentcore.runtime.audit.hooks import on_run_redirect_ignored

        for run_id, redir in ignored_redirects.items():
            logger.info(
                "delegate.run_redirect_ignored",
                execution_id=execution_id,
                run_id=run_id,
                feedback_preview=redir.feedback[:120],
            )
            on_run_redirect_ignored(
                run_id=run_id,
                feedback=redir.feedback,
                execution_id=execution_id,
            )

    if batch_metrics:
        m = batch_metrics[0]
        logger.info(
            "delegate.completed",
            call=call_idx,
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
    #
    # 协调态例外：host 靠 ``_pending_pause`` / ``_pending_boundary`` 投递 BOUNDARY_YIELD。
    # 若此处清掉标志，host 永远看不到（竞态）。协调路径保留标志、不 SUSPEND、不收口回合。
    if tool._pending_pause:
        if session is not None:
            logger.info("delegate.coord_pause_signal", call=call_idx, completed=len(results))
            return ToolResult(tool_call_id="", success=True, output="")
        tool._pending_pause = False
        logger.info("delegate.paused", call=call_idx, completed=len(results))
        return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)

    if tool._pending_boundary is not None:
        reason, nodes = tool._pending_boundary
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
            call=call_idx,
            reason=reason.value,
            boundary=[n.run_id for n in nodes],
            completed=len(results),
        )
        brief = format_boundary_for_ceo(tool, reason, plan, results, nodes)
        if session is not None:
            # Leave ``_pending_boundary`` for host to post BOUNDARY_YIELD + clear.
            return ToolResult(
                tool_call_id="",
                success=True,
                output=brief,
                output_limit=DELEGATE_OUTPUT_LIMIT,
            )
        tool._pending_boundary = None
        return ToolResult(
            tool_call_id="",
            success=True,
            output=brief,
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
            call=call_idx,
            failed=[n.run_id for n in failed_nodes],
            completed=len(results),
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=format_for_ceo(tool, plan, results, call_idx=call_idx),
            output_limit=DELEGATE_OUTPUT_LIMIT,
        )

    # §十一 来源卡接入 (方案①, 远期规划.md §4.5): snapshot the turn-accumulated sources
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

    from agentcore.tools.builtin.delegate.completion import (
        check_delegate_completion,
        format_completion_gap_message,
        resolve_completion_criteria,
    )

    criteria = resolve_completion_criteria(completion_criteria, plan)
    if criteria is not None:
        criteria_ok, gaps = check_delegate_completion(criteria, results)
        if not criteria_ok:
            gap_msg = format_completion_gap_message(gaps)
            logger.info(
                "delegate.completion_criteria_unmet",
                criteria=criteria.kind,
                gaps=gaps,
                execution_id=execution_id,
            )
            return ToolResult(
                tool_call_id="",
                success=True,
                output=gap_msg,
                output_limit=DELEGATE_OUTPUT_LIMIT,
                metadata=usage_metadata(call_usage),
                citations=new_citations or None,
            )

    if finalize and len(plan.nodes) == 1:
        only = results.get(plan.nodes[0].run_id)
        if only and only.phase is RunPhase.COMPLETED and only.content.strip():
            if session is not None:
                from agentcore.runtime.coordination.session import (
                    CoordinationEvent,
                    CoordinationEventKind,
                )

                session.post(
                    CoordinationEvent(
                        kind=CoordinationEventKind.ALL_COMPLETED,
                        payload={
                            "completed": 1,
                            "total": 1,
                            "output": only.content[:2000],
                        },
                    )
                )
            return direct_result(tool, only)

    output = format_for_ceo(tool, plan, results, call_idx=call_idx)
    if session is not None:
        from agentcore.runtime.coordination.session import (
            CoordinationEvent,
            CoordinationEventKind,
        )

        session.post(
            CoordinationEvent(
                kind=CoordinationEventKind.ALL_COMPLETED,
                payload={
                    "completed": len(session.completed_run_ids),
                    "total": session.total_workers,
                    "output": output[:4000],
                },
            )
        )
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        output_limit=DELEGATE_OUTPUT_LIMIT,
        metadata=usage_metadata(call_usage),
        citations=new_citations or None,
    )


async def drive_coordinated(
    tool: DelegateTool,
    plan: RunPlan,
    *,
    execution_id: str,
    seed_completed: dict[str, RunState] | None,
    finalize: bool,
    seed_notes: list[dict[str, str]] | None = None,
    complexity_hint: str = "standard",
    coordination: str = "none",
    call_idx: int | None = None,
    completion_criteria: Any = None,
    session: Any,
) -> ToolResult:
    """Background entry: same as ``drive`` but with an active coordination session."""
    return await drive(
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
        coordinate=False,
        session=session,
    )
