"""Durable resume pipeline orchestrator for plan_review / ask_user checkpoints."""

from __future__ import annotations

import contextlib
from dataclasses import asdict

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.board.channel import BoardChannel
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.desktop.channel import DesktopClientChannel
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.profiles import turn_profiles_for_turn
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.audit.hooks import bind_recorder
from agentcore.runtime.checkpoints import CheckpointDecision
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
from agentcore.runtime.pipeline.resume.settle import (
    append_resumed_tool_results,
    settle_resumed_suspension,
)
from agentcore.runtime.pipeline.resume.window import pre_pause_content, resumed_captain_window
from agentcore.runtime.resolve.prepare import _assemble_ceo_toolset, _wire_worker_memory_tools
from agentcore.runtime.runs import RunKind, RunPhase, RunSpec, build_captain_resumer
from agentcore.runtime.sessions import SessionLoader, SessionSaver, default_session_registry
from agentcore.runtime.skills import build_system_skill_registry
from agentcore.runtime.suspension import (
    SuspensionDeleter,
    SuspensionSaver,
    TurnSuspension,
    captain_transcript,
    turn_history,
)
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
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


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
) -> dict:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    Rebuilds the turn from the §8.3 turn journal and finishes it: re-wire the CEO
    toolset, seed the display journal with the pre-pause graph, **rebuild the CEO window
    by folding the journal facts** (:func:`resumed_captain_window` — the captain
    transcript is a projection of the journal, no longer read from ``frame.transcript``,
    执行级事件溯源 Phase 2 ④), apply the user's decision to the paused frame by kind
    (:func:`settle_resumed_suspension`), feed the settled result back as the suspended
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
    """
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

    journal_writer = TurnJournalWriter(
        turn_id=message_id,
        conversation_id=conversation_id,
        trace_id=suspension.trace_id or get_log_value("trace_id"),
        initial_seq=len(suspension.journal_entries),
    )
    journal_writer_token = current_journal_writer.set(journal_writer)
    audit_recorder, audit_token = bind_recorder(
        user_id=suspension.user_id,
        conversation_id=conversation_id,
        turn_id=message_id,
        trace_id=suspension.trace_id or get_log_value("trace_id"),
        captain_run_id=captain_run_id,
        delegated=bool(getattr(suspension, "plan", None) and getattr(suspension.plan, "nodes", None)),
    )
    fact_log = TurnFactLog(inherited_entries=list(suspension.journal_entries))
    fact_log_token = current_fact_log.set(fact_log)
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
            # §九.4: vision provider (QwenVL) — set VISION_API_KEY to enable; None ⇒
            # board_read returns a clean「读图能力未配置」error (「插上即用」).
            vision_reader=build_vision_reader(),
            cost_sink=vision_cost_sink,
        )
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
            )
            if settings.approval_gate_enabled
            else None
        )
        session_store = default_session_registry().get_or_create(conversation_id)
        checkpoint_enabled = settings.checkpoint_gate_enabled
        delegate_tool, revise_tool, debate_tool, chat_tools = _assemble_ceo_toolset(
            llm=llm,
            sink=sink,
            base_system_prompt=suspension.base_system_prompt,
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
            settled = await settle_resumed_suspension(
                suspension,
                decision=decision,
                note=note,
                selected=selected or [],
                sink=sink,
                delegate_tool=delegate_tool,
                execution_id=base_tool_context.execution_id,
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
            return {
                "message_id": message_id,
                "content": "",
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
            revise_tool=revise_tool,
            debate_tool=debate_tool,
            profile=profile,
            citations=citations,
            sink=sink,
            vision_cost_runs=vision_cost_sink,
            audit_drops=audit_recorder.drops,
        )
        await audit_recorder.flush()
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
        await audit_recorder.flush()
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
            "audit_drops": audit_recorder.drops,
        }
    finally:
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
        current_audit_recorder.reset(audit_token)
        turn_history.reset(history_token)
        # Do NOT close the sink here (see run_chat_pipeline): its owner closes it, so the
        # resumed turn's persist_turn_result tail (title / followups) still reaches the client.
        with contextlib.suppress(Exception):
            await llm.close()
