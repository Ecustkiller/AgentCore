"""Durable resume pipeline orchestrator for plan_review / ask_user checkpoints."""

from __future__ import annotations

import contextlib
import re
from dataclasses import asdict

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.board.channel import BoardChannel
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import AutonomyPolicy, new_id
from agentcore.desktop.channel import DesktopClientChannel
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import turn_profiles_for_turn
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.audit.hooks import bind_recorder
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.context import build_workspace_context, desktop_client_can_bind
from agentcore.runtime.costing import RunCost, captain_run_cost_from_state
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    error_event,
    message_end,
    message_start,
)
from agentcore.runtime.facts import TurnFactLog, current_fact_log
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.pipeline.resume.finish import finish_resume_turn, finish_terminal_resume
from agentcore.runtime.pipeline.resume.settle import append_resumed_tool_results
from agentcore.runtime.pipeline.resume.window import pre_pause_content, resumed_captain_window
from agentcore.runtime.recover import recover_turn
from agentcore.runtime.resolve.prepare import _assemble_ceo_toolset, _wire_worker_memory_tools
from agentcore.runtime.runs import RunKind, RunPhase, RunSpec, build_captain_resumer
from agentcore.runtime.session_persistence import SessionRosterWriter
from agentcore.runtime.sessions import SessionLoader, SessionSaver, default_session_registry
from agentcore.runtime.settlement import seed_settlement_dedupe_from_entries
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.runtime.suspension import (
    SuspensionDeleter,
    SuspensionSaver,
    TurnSuspension,
    captain_transcript,
    turn_history,
)
from agentcore.runtime.turn_state import TurnState
from agentcore.tools.builtin import (
    approval_class_tool_names,
    build_worker_registry,
    delegation_grantable_tool_names,
    per_call_tool_names,
)
from agentcore.tools.builtin.board_ops import BoardOpsTool
from agentcore.tools.builtin.board_read import BoardReadTool
from agentcore.tools.protocol import ToolContext
from agentcore.vision import build_vision_reader
from agentcore.workspace.locate import workspace_channel_for_tools
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

_WORKSPACE_CONTEXT_RE = re.compile(
    r"<workspace_context>.*?</workspace_context>\n?",
    re.DOTALL,
)


def _restamp_workspace_facts(prompt: str, facts: str) -> str:
    """Replace (or append) ``<workspace_context>`` so post-bind resume workers see the new location."""
    stripped = _WORKSPACE_CONTEXT_RE.sub("", prompt or "").rstrip()
    if not facts:
        return stripped
    marker = "</runtime_context>"
    idx = stripped.find(marker)
    if idx >= 0:
        insert_at = idx + len(marker)
        return stripped[:insert_at] + "\n" + facts + stripped[insert_at:]
    return stripped + "\n" + facts


async def resume_chat_pipeline(
    *,
    suspension: TurnSuspension,
    decision: CheckpointDecision,
    note: str,
    selected: list[str] | None = None,
    sink: EventSink,
    backend: WorkspaceBackend,
    history: list[dict] | None = None,
    board_id: str | None = None,
    llm_credentials: LLMCredentials | None = None,
    profile_set: ProfileSet | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
    llm_supports_tools: bool | None = None,
    autonomy_policy: AutonomyPolicy | None = None,
    x_client_platform: str | None = None,
) -> dict:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    Rebuilds the turn from the §8.3 turn journal and finishes it: re-wire the CEO
    toolset, seed the display journal with the pre-pause graph, **rebuild the CEO window
    by folding the journal facts** (:func:`resumed_captain_window` — the captain
    transcript is a projection of the journal, no longer read from ``frame.transcript``,
    执行级事件溯源 Phase 2 ④), apply the user's decision to the paused frame by kind
    (:func:`recover_turn`), feed the settled result back as the suspended
    tool result, and — unless the answer ended the turn in-band (ask_user ``stop``) — run
    the CEO loop on the rebuilt window to its reply. ``history`` is the reloaded prior
    context (the caller passes ``load_chat_context(...)[:-1]`` exactly as a fresh send),
    spliced into the window head since the journal stores only its length. The whole turn
    is billed ONCE here, under the ORIGINAL ``message_id`` so the assistant row + ledger
    reuse it. A downstream checkpoint can pause again — the same hooks re-persist a fresh
    frame, so resume is fully re-entrant. ``selected`` carries the user's option picks
    (ask_user only). Returns the same result shape as :func:`run_chat_pipeline`.

    ``board_id`` marks the resumed turn as a 白板会话 (AI协作白板.md §六 M2): re-derived by
    the caller from the conversation's board binding (authoritative in the DB, not stored in
    the frame), so a board turn that paused at a checkpoint regains the ``board_ops`` tool +
    its :class:`BoardChannel` on resume and can keep drawing on the user's canvas. ``None``
    for every ordinary chat — then ``board_ops`` is neither wired nor reachable, exactly as
    on the fresh-turn path.

    ``autonomy_policy`` mirrors :func:`run_chat_pipeline`: the user's CURRENT
    capability-authorization posture (安全权限与治理 §三), resolved by the caller at
    resume time — not frozen into the frame, so a mid-pause settings change applies.
    ``None`` falls back to ``first_grant``.
    """
    if autonomy_policy is None:
        autonomy_policy = AutonomyPolicy.FIRST_GRANT
    profiles = turn_profiles_for_turn(profile_set, llm_credentials)
    message_id = suspension.message_id
    conversation_id = suspension.conversation_id
    captain_run_id = suspension.captain_run_id or new_id()
    # 真·多模型辩手：同 run.py，回合 llm = DeepSeek 默认外包一层 ProviderRouter（resume 也可能
    # 续跑含多模型辩手的辩论）。无前缀照走默认、零行为变化；路由器生命周期由下方 llm.close() 释放。
    llm = pipeline_pkg.build_router_around(pipeline_pkg.build_provider(llm_credentials))
    # Republish history so a re-pause DURING the settle (a downstream checkpoint while
    # resume_plan runs) captures it into the fresh frame — symmetric with the live turn
    # (Phase 2 ⑤). Reset in finally.
    history_token = turn_history.set(history or [])
    from agentcore.core.log_context import get_log_value

    # Seed past both the pause snapshot AND any live append-on-emit rows that outran
    # the sidecar (tool_use_end / message_final / … after pause) — else UniqueViolation.
    journal_base = len(suspension.journal_entries)
    db_max_seq: int | None = None
    initial_seq = journal_base
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import TurnJournalRepository

        async with async_session_factory() as db:
            db_max_seq = await TurnJournalRepository(db).max_seq(message_id)
        if db_max_seq is not None:
            initial_seq = max(journal_base, db_max_seq + 1)
    except Exception as e:  # noqa: BLE001 — best-effort; never block resume on journal probe
        logger.warning(
            "pipeline.resume_initial_seq_fallback",
            message_id=message_id,
            journal_entries_count=journal_base,
            error=str(e),
        )
        initial_seq = journal_base

    logger.info(
        "pipeline.resume_start",
        message_id=message_id,
        conversation_id=conversation_id,
        decision=decision.value,
        journal_entries_count=journal_base,
        initial_seq=initial_seq,
        db_max_seq=db_max_seq,
    )

    journal_writer = TurnJournalWriter(
        turn_id=message_id,
        conversation_id=conversation_id,
        trace_id=suspension.trace_id or get_log_value("trace_id"),
        initial_seq=initial_seq,
    )
    # D8：冷路端点已预写 ``*_resolved``；claim 把它收进 journal_entries。种子化 dedupe，
    # 使 recover 路径的同形 emit 跳过重复落库（SSE 仍发）。
    seed_settlement_dedupe_from_entries(journal_writer, suspension.journal_entries)
    journal_writer_token = current_journal_writer.set(journal_writer)
    audit_recorder, audit_token = bind_recorder(
        user_id=suspension.user_id,
        conversation_id=conversation_id,
        turn_id=message_id,
        trace_id=suspension.trace_id or get_log_value("trace_id"),
        captain_run_id=captain_run_id,
        delegated=bool(getattr(suspension, "plan", None) and getattr(suspension.plan, "nodes", None)),
    )
    # Session roster write-through (as-built: 成本配额 §三): fire-and-forget + turn-end flush (parity with run).
    roster_writer = SessionRosterWriter.wrap(session_saver)
    session_saver = roster_writer.save if roster_writer is not None else None
    fact_log = TurnFactLog(inherited_entries=list(suspension.journal_entries))
    fact_log_token = current_fact_log.set(fact_log)
    execution_id_token = None
    bound_execution_id: str | None = None
    try:
        worker_tools = build_worker_registry(backend=backend)
        _wire_worker_memory_tools(
            worker_tools,
            memory_enabled=suspension.memory_enabled,
            folder_id=suspension.folder_id,
        )
        # Same system-skill registry as a fresh turn so the resumed CEO loop can
        # still consult_skill (提示词瘦身 P2), including the legal vertical skill when
        # enabled. The CEO prompt itself is replayed from the stored transcript
        # (already slim + 能力目录), so no directory re-render.
        skill_registry = build_system_skill_registry(include_legal=settings.legal_vertical_enabled)
        # AI 协作白板 (§六 M2): a board-bound turn that paused at a checkpoint regains its
        # BoardChannel on resume, so the continued CEO loop can still reach the user's open
        # canvas via ``board_ops``. Rebuilt fresh (channels aren't serializable) from the
        # caller's re-derived ``board_id`` + this resume's sink, bound on the SAME shared
        # interaction bridge the ops-resolve endpoint settles. ``None`` ⇒ ordinary chat,
        # tool unwired below — symmetric with the fresh-turn path (run.py).
        board_channel = (
            BoardChannel(
                sink=sink,
                conversation_id=conversation_id,
                board_id=board_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.board_op_timeout_seconds,
            )
            if board_id
            else None
        )
        desktop_channel = (
            DesktopClientChannel(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.board_op_timeout_seconds,
            )
            if backend.location == "local"
            else None
        )
        workspace_channel = workspace_channel_for_tools(
            backend,
            sink=sink,
            conversation_id=conversation_id,
        )
        # AI 协作白板 §九.4 Gap ②: the resumed turn's vision cost sink, shared by reference
        # across derived run contexts — symmetric with the fresh-turn path (run.py). A
        # board_read after the checkpoint bills its 读图 row here; folded into cost_runs below.
        vision_cost_sink: list[RunCost] = []
        base_tool_context = ToolContext(
            execution_id=new_id(),
            run_id=new_id(),
            agent_id="default",
            backend=backend,
            user_id=suspension.user_id,
            conversation_id=conversation_id,
            board_channel=board_channel,
            desktop_channel=desktop_channel,
            workspace_channel=workspace_channel,
            # §九.4: vision provider (QwenVL) — set VISION_API_KEY to enable; None ⇒
            # board_read returns a clean「读图能力未配置」error (「插上即用」).
            vision_reader=build_vision_reader(),
            cost_sink=vision_cost_sink,
        )
        from agentcore.runtime.coordination.session import current_execution_id

        bound_execution_id = base_tool_context.execution_id
        execution_id_token = current_execution_id.set(bound_execution_id)
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
                timeout_overrides=settings.approval_timeout_overrides,
                file_op_tools=approval_class_tool_names(),
                per_call_tools=per_call_tool_names(),
                delegation_grantable_tools=delegation_grantable_tool_names(),
                autonomy_policy=autonomy_policy,
            )
            if settings.approval_gate_enabled
            else None
        )
        session_store = default_session_registry().get_or_create(conversation_id)
        checkpoint_enabled = settings.checkpoint_gate_enabled
        # Re-stamp environment facts onto the stored worker base: resume rebuilds the
        # backend from the CURRENT binding (bind-during-ask_user → local), so workers
        # delegated after resume must not inherit a stale cloud ``<workspace_context>``.
        desktop_online = (
            desktop_client_can_bind(x_client_platform) or backend.location == "local"
        )
        refreshed_base = _restamp_workspace_facts(
            suspension.base_system_prompt,
            build_workspace_context(backend, desktop_online=desktop_online),
        )
        delegate_tool, debate_tool, chat_tools = _assemble_ceo_toolset(
            llm=llm,
            sink=sink,
            base_system_prompt=refreshed_base,
            user_message=suspension.user_message,
            history=[],
            worker_tools=worker_tools,
            base_tool_context=base_tool_context,
            profiles=profiles,
            approval_gate=approval_gate,
            session_store=session_store,
            session_saver=session_saver,
            session_loader=session_loader,
            conversation_id=conversation_id,
            captain_run_id=captain_run_id,
            checkpoint_enabled=checkpoint_enabled,
            message_id=message_id,
            suspension_saver=suspension_saver,
            suspension_deleter=suspension_deleter,
            backend_location=backend.location,
            skill_registry=skill_registry,
            folder_id=suspension.folder_id,
            memory_enabled=suspension.memory_enabled,
            autonomy_policy=autonomy_policy,
            advertise_bind_local_folder=checkpoint_enabled
            and desktop_client_can_bind(x_client_platform),
        )

        # AI 协作白板: re-give the resumed CEO the board tools (``board_ops`` §六 M2 +
        # ``board_read`` §九) so it can keep drawing / reading after the checkpoint. Registered
        # into the assembled toolset BEFORE the loop runs, so they join this resume's LLM
        # function catalog (the replayed system prompt is the stored slim one — the catalog,
        # not the prompt, is what makes a tool callable). Only in a 白板会话.
        if board_channel is not None:
            chat_tools.register(BoardOpsTool())
            chat_tools.register(BoardReadTool())

        sink.emit(message_start(message_id, conversation_id=conversation_id))
        # Continue the pre-pause exchange: seed the journal so the persisted turn
        # journal (projected as the message's runs) replays the whole graph +
        # checkpoint, then settle the pause.
        sink.seed_journal(suspension.journal)

        # Rebuild the CEO window by FOLDING the turn journal (Phase 2 ④): the captain
        # transcript at pause is a projection of the §8.3 facts, not a stored blob —
        # window_from_journal(journal_entries) + the reloaded history reconstructs the
        # exact messages the CEO suspended on (the conformance golden gates this ==).
        transcript = resumed_captain_window(suspension, history)

        # Publish the pre-pause CEO transcript so a re-pause DURING the settle (a
        # second downstream checkpoint while resume_plan runs) captures the same
        # transcript the CEO is still suspended on — symmetric with the original pause.
        token = captain_transcript.set(transcript)
        try:
            # Single recover primitive: journal projection → seed WaveScheduler / settle.
            turn_state = TurnState.from_journal(
                suspension.journal_entries,
                display_journal=suspension.journal,
            )
            settled = await recover_turn(
                state=turn_state,
                sink=sink,
                delegate_tool=delegate_tool,
                debate_tool=debate_tool,
                execution_id=base_tool_context.execution_id,
                suspension=suspension,
                decision=decision,
                note=note,
                selected=selected or [],
            )
            logger.info(
                "pipeline.resume_settled",
                checkpoint_id=suspension.checkpoint_id,
                decision=decision.value,
                kind=suspension.kind.value,
            )
        finally:
            captain_transcript.reset(token)

        # Rebuild the CEO transcript: the folded window (ending at the assistant
        # suspended call) + that call's settled tool result.
        messages = list(transcript)
        # Carry the CEO's pre-pause reply forward: the resumed loop below starts from a
        # blank content, so without this the persisted content (and the next turn's LLM
        # history) would lose everything written before the pause — parity with live.
        pre_pause = pre_pause_content(transcript)
        append_resumed_tool_results(messages, suspension.tool_call_id, settled.output)

        # 终稿多段衔接: when the pause kept deliverable prose, steer the resumed answer
        # round to continue it (join_segments alone can't invent transitions). Skip when
        # the user STOPPED (terminal_text path finishes without another CEO round).
        if pre_pause.strip() and settled.terminal_text is None:
            from agentcore.runtime.engine import deliverable_continuity_instruction
            from agentcore.runtime.facts import NoteFact, record_turn_fact

            continuity = deliverable_continuity_instruction(prior_deliverable=pre_pause)
            messages.append(LLMMessage(role="user", content=continuity))
            record_turn_fact(
                NoteFact(
                    role="user",
                    content=continuity,
                    reason="continuity",
                    run_id=captain_run_id,
                ).to_fact()
            )

        # ask_user stop: the closing note IS the reply (terminal effect) — finish
        # without another CEO round, mirroring the engine's terminal-effect branch.
        if settled.terminal_text is not None:
            if settled.terminal_text:
                sink.emit(content_delta(settled.terminal_text))
            result = finish_terminal_resume(
                message_id=message_id,
                pre_pause_content=pre_pause,
                closing=settled.terminal_text,
                sink=sink,
            )
            await audit_recorder.flush()
            if roster_writer is not None:
                await roster_writer.flush()
            result["audit_drops"] = audit_recorder.drops
            return result

        # Otherwise run the CEO loop to its reply (it may delegate / ask again).
        profile = profiles.get("chat")
        turn_model = profiles.model_for("chat")
        citations: list[dict] = []
        captain_spec = RunSpec(
            run_id=captain_run_id,
            agent_id=captain_run_id,
            agent_name="CEO",
            kind=RunKind.CAPTAIN,
            task=suspension.user_message,
            role="CEO",
            depth=0,
            parent_run_id=None,
        )
        run_captain = build_captain_resumer(
            llm=llm,
            tools=chat_tools,
            sink=sink,
            base_tool_context=base_tool_context,
            profile=profile,
            turn_model=turn_model,
            citation_sink=citations,
            approval_gate=approval_gate,
            supports_tools=llm_supports_tools,
        )
        captain_state = await run_captain(captain_spec, messages)

        if captain_state.phase is RunPhase.FAILED:
            err = captain_state.error or "captain resume failed"
            sink.emit(error_event(ErrorCode.PIPELINE_ERROR, err))
            sink.emit(message_end(FinishReason.ERROR))
            with contextlib.suppress(Exception):
                await sink.flush_stream_state()
            from agentcore.conversation.store.merge import pick_longest
            from agentcore.runtime.engine import join_segments
            from agentcore.runtime.events.stream_checkpointer import (
                CHANNEL_CAPTAIN_CONTENT,
                CHANNEL_CAPTAIN_REASONING,
            )

            mem = sink.stream_memory_snapshot()
            post = pick_longest(
                mem.get(CHANNEL_CAPTAIN_CONTENT),
                captain_state.content,
                sink.streamed_content(),
            )
            salvaged_content = join_segments(pre_pause, post)
            salvaged_reasoning = pick_longest(
                mem.get(CHANNEL_CAPTAIN_REASONING),
                captain_state.reasoning,
                sink.streamed_reasoning(),
            )
            # Bill the resumed captain's partial spend on a hard failure (B-deep 失败
            # 计费), same as the fresh-turn path: priced onto captain_state, persisted
            # by _persist_turn_result even without an assistant reply. No usage → no row.
            cost_runs = [
                *(
                    [asdict(captain_run_cost_from_state(captain_run_id, captain_state))]
                    if captain_state.usage
                    else []
                ),
                # A board_read after the checkpoint may have billed before the captain
                # died (§九.4 Gap ②): carry those vision rows so the spend isn't lost.
                *(asdict(r) for r in vision_cost_sink),
            ]
            await audit_recorder.flush()
            if roster_writer is not None:
                await roster_writer.flush()
            return {
                "message_id": message_id,
                "content": salvaged_content,
                "reasoning_content": salvaged_reasoning or None,
                "error": err,
                "error_code": ErrorCode.PIPELINE_ERROR,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
                "audit_drops": audit_recorder.drops,
            }

        result = finish_resume_turn(
            message_id=message_id,
            captain_run_id=captain_run_id,
            captain_state=captain_state,
            pre_pause_content=pre_pause,
            delegate_tool=delegate_tool,
            debate_tool=debate_tool,
            profile=profile,
            citations=citations,
            sink=sink,
            vision_cost_runs=vision_cost_sink,
            audit_drops=audit_recorder.drops,
        )
        # Drain journal → audit projection fully BEFORE 定格 audit_drops (parity with
        # run_chat_pipeline): the finally re-flush would otherwise drop more audit writes
        # after drops was read, undercounting turn_metrics.audit_drops. Best-effort.
        with contextlib.suppress(Exception):
            await journal_writer.flush()
        await audit_recorder.flush()
        if roster_writer is not None:
            await roster_writer.flush()
        with contextlib.suppress(Exception):
            await sink.flush_stream_state()
        result["audit_drops"] = audit_recorder.drops
        return result

    except Exception as e:
        logger.error("pipeline.resume_error", error=str(e), exc_info=True)
        # Preserve a structured AgentCoreError.code that escaped to the resume
        # boundary instead of flattening every crash to PIPELINE_ERROR (统一错误码).
        code, message, err_ctx = error_fields_for(
            e, fallback_code=ErrorCode.PIPELINE_ERROR, fallback_message=str(e)
        )
        sink.emit(error_event(code, message, context=err_ctx))
        sink.emit(message_end(FinishReason.ERROR))
        with contextlib.suppress(Exception):
            await sink.flush_stream_state()
        from agentcore.conversation.store.merge import pick_longest
        from agentcore.runtime.engine import join_segments
        from agentcore.runtime.events.stream_checkpointer import (
            CHANNEL_CAPTAIN_CONTENT,
            CHANNEL_CAPTAIN_REASONING,
        )

        mem = sink.stream_memory_snapshot()
        post = pick_longest(mem.get(CHANNEL_CAPTAIN_CONTENT), sink.streamed_content())
        # pre_pause may be unbound if the crash was before it was computed.
        prior = locals().get("pre_pause") or ""
        salvaged_content = join_segments(prior, post) if prior or post else ""
        salvaged_reasoning = pick_longest(
            mem.get(CHANNEL_CAPTAIN_REASONING),
            sink.streamed_reasoning(),
        )
        await audit_recorder.flush()
        if roster_writer is not None:
            await roster_writer.flush()
        return {
            "message_id": message_id,
            "content": salvaged_content,
            "reasoning_content": salvaged_reasoning or None,
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
            "audit_drops": audit_recorder.drops,
        }
    finally:
        # 触发点①：resume turn 结束防御性 orphan
        with contextlib.suppress(Exception):
            from agentcore.runtime.interaction_orphan import orphan_registry_pending

            await orphan_registry_pending(
                conversation_id, turn_id=message_id
            )
        current_fact_log.reset(fact_log_token)
        # Drain the append-on-emit journal BEFORE dropping the writer: an abandoned in-flight
        # write leaves a checked-out DB connection for the GC to terminate (asyncpg
        # connection_lost noise). Best-effort — a drain failure must never break turn teardown.
        with contextlib.suppress(Exception):
            await journal_writer.flush()
        current_journal_writer.reset(journal_writer_token)
        from agentcore.runtime.audit.recorder import current_audit_recorder

        with contextlib.suppress(Exception):
            await audit_recorder.flush()
        with contextlib.suppress(Exception):
            if roster_writer is not None:
                await roster_writer.flush()
        current_audit_recorder.reset(audit_token)
        turn_history.reset(history_token)
        if execution_id_token is not None:
            from agentcore.runtime.coordination.session import (
                clear_active_coordination,
                current_execution_id,
            )

            # Settle may realign to the pause-turn id; clear that registry key.
            eid = current_execution_id.get() or bound_execution_id
            if eid:
                with contextlib.suppress(Exception):
                    clear_active_coordination(eid)
            current_execution_id.reset(execution_id_token)
        # Do NOT close the sink here (see run_chat_pipeline): its owner closes it, so the
        # resumed turn's persist_turn_result tail (title / followups) still reaches the client.
        with contextlib.suppress(Exception):
            await llm.close()
