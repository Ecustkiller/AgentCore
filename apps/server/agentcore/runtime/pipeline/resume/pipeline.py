"""Durable resume pipeline orchestrator for plan_review / ask_user checkpoints."""

from __future__ import annotations

import contextlib
from dataclasses import asdict

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.costing import captain_run_cost_from_state
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    error_event,
    message_end,
    message_start,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.pipeline.resume.finish import finish_resume_turn, finish_terminal_resume
from agentcore.runtime.pipeline.resume.settle import append_resumed_tool_results, settle_resumed_suspension
from agentcore.runtime.pipeline.resume.window import pre_pause_content, resumed_captain_window
from agentcore.runtime.resolve.prepare import _assemble_ceo_toolset
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
from agentcore.tools.builtin import build_worker_registry, file_mutation_tool_names
from agentcore.tools.protocol import ToolContext
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
    llm_credentials: LLMCredentials | None = None,
    profile_set: ProfileSet | None = None,
    session_saver: SessionSaver | None = None,
    session_loader: SessionLoader | None = None,
    suspension_saver: SuspensionSaver | None = None,
    suspension_deleter: SuspensionDeleter | None = None,
) -> dict:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    Rebuilds the turn from the §18.3 turn journal and finishes it: re-wire the CEO
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
    """
    profiles = profile_set or default_profile_set()
    message_id = suspension.message_id
    conversation_id = suspension.conversation_id
    captain_run_id = suspension.captain_run_id or new_id()
    llm = pipeline_pkg.build_provider(llm_credentials)
    # Republish history so a re-pause DURING the settle (a downstream checkpoint while
    # resume_plan runs) captures it into the fresh frame — symmetric with the live turn
    # (Phase 2 ⑤). Reset in finally.
    history_token = turn_history.set(history or [])
    try:
        worker_tools = build_worker_registry(backend=backend)
        # Same system-skill registry as a fresh turn so the resumed CEO loop can
        # still consult_skill (提示词瘦身 P2). The CEO prompt itself is replayed from
        # the stored transcript (already slim + 能力目录), so no directory re-render.
        skill_registry = build_system_skill_registry()
        base_tool_context = ToolContext(
            execution_id=new_id(),
            run_id=new_id(),
            agent_id="default",
            backend=backend,
            user_id=suspension.user_id,
            conversation_id=conversation_id,
        )
        approval_gate = (
            ApprovalGate(
                sink=sink,
                conversation_id=conversation_id,
                registry=default_interaction_registry(),
                timeout_seconds=settings.approval_timeout_seconds,
                file_op_tools=file_mutation_tool_names(),
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
        )

        sink.emit(message_start(message_id, conversation_id=conversation_id))
        # Continue the pre-pause exchange: seed the journal so the persisted turn
        # journal (projected as the message's runs) replays the whole graph +
        # checkpoint, then settle the pause.
        sink.seed_journal(suspension.journal)

        # Rebuild the CEO window by FOLDING the turn journal (Phase 2 ④): the captain
        # transcript at pause is a projection of the §18.3 facts, not a stored blob —
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
            return finish_terminal_resume(
                message_id=message_id,
                pre_pause_content=pre_pause,
                closing=settled.terminal_text,
                sink=sink,
            )

        # Otherwise run the CEO loop to its reply (it may delegate / ask again).
        profile = profiles.get("chat")
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
            citation_sink=citations,
            approval_gate=approval_gate,
        )
        captain_state = await run_captain(captain_spec, messages)

        if captain_state.phase is RunPhase.FAILED:
            err = captain_state.error or "captain resume failed"
            sink.emit(error_event(ErrorCode.PIPELINE_ERROR, err))
            sink.emit(message_end(FinishReason.ERROR))
            # Bill the resumed captain's partial spend on a hard failure (B-deep 失败
            # 计费), same as the fresh-turn path: priced onto captain_state, persisted
            # by _persist_turn_result even without an assistant reply. No usage → no row.
            cost_runs = (
                [asdict(captain_run_cost_from_state(captain_run_id, captain_state))]
                if captain_state.usage
                else []
            )
            return {
                "message_id": message_id,
                "content": "",
                "error": err,
                "error_code": ErrorCode.PIPELINE_ERROR,
                "finish_reason": FinishReason.ERROR,
                "cost_runs": cost_runs,
            }

        return finish_resume_turn(
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
        )

    except Exception as e:
        logger.error("pipeline.resume_error", error=str(e), exc_info=True)
        # Preserve a structured AgentCoreError.code that escaped to the resume
        # boundary instead of flattening every crash to PIPELINE_ERROR (统一错误码).
        code, message = error_fields_for(
            e, fallback_code=ErrorCode.PIPELINE_ERROR, fallback_message=str(e)
        )
        sink.emit(error_event(code, message))
        sink.emit(message_end(FinishReason.ERROR))
        return {
            "message_id": message_id,
            "content": "",
            "error": str(e),
            "error_code": code,
            "finish_reason": FinishReason.ERROR,
        }
    finally:
        turn_history.reset(history_token)
        sink.close()
        with contextlib.suppress(Exception):
            await llm.close()
