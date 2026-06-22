"""Durable resume pipeline for plan_review / ask_user checkpoints."""

import contextlib
from dataclasses import asdict
from typing import NamedTuple

import agentcore.runtime.pipeline as pipeline_pkg
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect, new_id
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.modes import ProfileSet, default_profile_set
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.citations import merge_citations, out_of_range_markers
from agentcore.runtime.costing import aggregate_cost, captain_run_cost_from_state
from agentcore.runtime.engine import join_segments
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    checkpoint_resolved,
    citations_event,
    content_delta,
    error_event,
    message_end,
    message_start,
    plan_review_resolved,
)
from agentcore.runtime.interaction import default_interaction_registry
from agentcore.runtime.journal import (
    completed_from_journal,
    plan_from_journal,
    window_from_journal,
)
from agentcore.runtime.pipeline.finalize import _build_runs_payload
from agentcore.runtime.pipeline.prepare import _assemble_ceo_toolset
from agentcore.runtime.runs import (
    RunKind,
    RunPhase,
    RunSpec,
    build_captain_resumer,
)
from agentcore.runtime.sessions import (
    SessionLoader,
    SessionSaver,
    default_session_registry,
)
from agentcore.runtime.skills import (
    build_system_skill_registry,
)
from agentcore.runtime.suspension import (
    AskUserSuspension,
    PlanReviewSuspension,
    SuspensionDeleter,
    SuspensionSaver,
    TurnSuspension,
    captain_transcript,
    turn_history,
)
from agentcore.tools.builtin import (
    build_worker_registry,
    file_mutation_tool_names,
)
from agentcore.tools.builtin.ask_user import ask_user_tool_result
from agentcore.tools.builtin.debate import DebateTool
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.builtin.revise import ReviseTool
from agentcore.tools.protocol import ToolContext
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


def _append_resumed_tool_results(
    messages: list[LLMMessage], tool_call_id: str, output: str
) -> None:
    """Close the suspended tool-call in the rebuilt CEO transcript (结构化挂起 2b).

    The transcript ends with the assistant message that issued the suspended call
    (``delegate`` for plan_review, ``ask_user`` for ask_user — the pause happened
    inside it). Append the settled result as that call's tool result so the loop
    continues from a valid assistant-tool_call → tool-result pair. Any SIBLING
    tool_calls in the same assistant turn (a rare concurrent call) get a placeholder
    result, since every tool_call MUST have a matching result or the next request
    400s — their work wasn't captured (the pause unwound only the suspended call).
    """
    last = messages[-1] if messages else None
    if last is None or last.role != "assistant" or not last.tool_calls:
        messages.append(LLMMessage(role="tool", content=output, tool_call_id=tool_call_id))
        return
    target = tool_call_id or (last.tool_calls[0].id if last.tool_calls else "")
    for tc in last.tool_calls:
        if tc.id == target:
            messages.append(LLMMessage(role="tool", content=output, tool_call_id=tc.id))
        else:
            messages.append(
                LLMMessage(
                    role="tool",
                    content="（该并行工具调用在本回合暂停时未保留结果，已跳过。）",
                    tool_call_id=tc.id,
                )
            )


class _SettledSuspension(NamedTuple):
    """The outcome of applying a resume decision to a paused frame (结构化挂起 2b).

    ``output`` is the suspended tool-call's result text, fed back into the rebuilt
    CEO transcript. ``terminal_text`` is set only when the answer ended the turn
    in-band (ask_user ``stop``) — its closing note IS the reply, so resume finishes
    on it WITHOUT another CEO round (mirroring the engine's terminal-effect branch);
    ``None`` means run the CEO loop to its reply (plan_review always; ask_user
    continue / adjust / timeout).
    """

    output: str
    terminal_text: str | None


async def _settle_resumed_suspension(
    suspension: TurnSuspension,
    *,
    decision: CheckpointDecision,
    note: str,
    selected: list[str],
    sink: EventSink,
    delegate_tool: DelegateTool,
    execution_id: str,
) -> _SettledSuspension:
    """Apply the user's resume decision to the paused frame, by kind (结构化挂起 2b).

    plan_review: emit the resolution, then ``delegate.resume_plan`` drives the
    remaining tail (continue / adjust-steer / stop-skip) and returns the workers'
    product — always fed back to the CEO loop (which writes the overview).

    ask_user: emit the resolution, then map the answer to the ``ask_user`` tool
    result via the shared :func:`ask_user_tool_result`. A ``stop`` yields a terminal
    result whose closing note ends the turn directly (no CEO round); the picks are
    validated against the offered options just like the live path.
    """
    if isinstance(suspension, AskUserSuspension):
        response = CheckpointResponse(decision=decision, note=note, selected=list(selected))
        # Drop any pick that was not on some question's menu (same guard as the live
        # tool; the desktop composes its answer into ``note`` and sends no picks).
        allowed = {o for q in suspension.questions for o in q.get("options", [])}
        response.selected = [s for s in response.selected if s in allowed]
        sink.emit(
            checkpoint_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=response.decision.value,
                note=response.note,
                selected=response.selected,
            )
        )
        result = ask_user_tool_result(response)
        terminal = result.final_text if result.effect is ToolEffect.INTERACT else None
        return _SettledSuspension(result.output, terminal)

    if isinstance(suspension, PlanReviewSuspension):
        sink.emit(
            plan_review_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=decision.value,
                note=note,
            )
        )
        # Re-seed finished workers from the §18.3 journal run-final facts (执行级事件溯源
        # Phase 2 ⑥ — `completed_from_journal` == the dropped `frame.completed`, gated by
        # the conformance golden), so the resumed plan bills the whole graph once without
        # the旁路 blob. Falls back to the in-memory `completed` for a same-process resume
        # (tests) whose journal was not hydrated; a claimed frame always carries the facts
        # (else `_resumed_captain_window` already raised on the empty journal upstream).
        seed_completed = completed_from_journal(suspension.journal_entries) or suspension.completed
        # Rebuild the DAG from the journal's plan_snapshot fact (执行级事件溯源 Phase 2 —
        # `plan_from_journal` == the dropped `frame.plan`, gated by the conformance golden),
        # so the resumed drive re-mints nothing and its run_ids match `seed_completed`. Same
        # fallback posture as the seed: the in-memory `plan` carrier covers a same-process
        # resume (tests) whose journal was not bound; a claimed frame always carries the fact.
        plan = plan_from_journal(suspension.journal_entries) or suspension.plan
        delegate_result = await delegate_tool.resume_plan(
            plan,
            seed_completed,
            decision=decision,
            note=note,
            checkpoint_run_ids=suspension.checkpoint_run_ids,
            execution_id=execution_id,
        )
        return _SettledSuspension(delegate_result.output, None)

    raise ValueError(f"unknown suspension kind: {suspension.kind!r}")


def _resumed_captain_window(
    suspension: TurnSuspension, history: list[dict] | None
) -> list[LLMMessage]:
    """Rebuild the resumed CEO window from the §18.3 turn journal (Phase 2 ④/⑤).

    The captain transcript at pause is a PROJECTION of the journal, not a stored blob:
    fold ``suspension.journal_entries`` (the fact stream re-hydrated by ``claim_paused_turn``
    from ``turn_journal``, or carried in the Sidecar's local frame) back into the LLM
    window via :func:`window_from_journal`, splicing the reloaded conversation ``history``
    between the captured system prompt and the user message (the journal stores only its
    length — history is itself a projection of earlier turns, supplied by the caller exactly
    as a fresh send builds it: the cloud reloads it from the message DB, the Sidecar from
    its local frame record). The captain run is inferred from the journal's first
    ``role="captain"`` round_boundary, so it does not depend on the frame's ``captain_run_id``.

    ``suspension.transcript`` is NO LONGER serialized (Phase 2 ⑤) — it survives only as an
    in-memory carrier on a same-process resume (tests), so a non-empty one is used (with a
    warning) but a claimed frame's is empty. When BOTH the journal and the in-memory
    transcript are empty the pause is unrecoverable (its best-effort ``turn_journal`` write
    was lost): fail LOUD rather than resume on a silently empty window.
    """
    history_msgs = (
        [LLMMessage(role=h["role"], content=h["content"]) for h in history] if history else None
    )
    window = window_from_journal(suspension.journal_entries, history=history_msgs)
    if window:
        return window
    if suspension.transcript:
        logger.warning(
            "resume.window_from_frame_fallback",
            message_id=suspension.message_id,
            reason="journal_unavailable_inmemory_transcript",
            frame_transcript_len=len(suspension.transcript),
        )
        return list(suspension.transcript)
    raise RuntimeError(
        "resume: cannot rebuild the CEO window — no journal_entries to fold and no "
        "in-memory transcript (the pause's turn_journal write was lost); "
        f"message_id={suspension.message_id}"
    )


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
    by folding the journal facts** (:func:`_resumed_captain_window` — the captain
    transcript is a projection of the journal, no longer read from ``frame.transcript``,
    执行级事件溯源 Phase 2 ④), apply the user's decision to the paused frame by kind
    (:func:`_settle_resumed_suspension`), feed the settled result back as the suspended
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
        worker_tools = build_worker_registry()
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
        transcript = _resumed_captain_window(suspension, history)

        # Publish the pre-pause CEO transcript so a re-pause DURING the settle (a
        # second downstream checkpoint while resume_plan runs) captures the same
        # transcript the CEO is still suspended on — symmetric with the original pause.
        token = captain_transcript.set(transcript)
        try:
            settled = await _settle_resumed_suspension(
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
        pre_pause_content = _pre_pause_content(transcript)
        _append_resumed_tool_results(messages, suspension.tool_call_id, settled.output)

        # ask_user stop: the closing note IS the reply (terminal effect) — finish
        # without another CEO round, mirroring the engine's terminal-effect branch.
        if settled.terminal_text is not None:
            if settled.terminal_text:
                sink.emit(content_delta(settled.terminal_text))
            return _finish_terminal_resume(
                message_id=message_id,
                pre_pause_content=pre_pause_content,
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

        return _finish_resume_turn(
            message_id=message_id,
            captain_run_id=captain_run_id,
            captain_state=captain_state,
            pre_pause_content=pre_pause_content,
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


def _pre_pause_content(transcript: list[LLMMessage]) -> str:
    """The CEO's pre-pause reply text for a resumed turn (结构化挂起 2b parity).

    The durable frame's ``transcript`` ends with THIS turn's assistant rounds (the last
    carries the suspended tool_call). A fresh-process resume re-runs the CEO loop from a
    blank ``final_content``, so without this the persisted ``content`` would keep ONLY
    the post-resume text — losing whatever the CEO wrote before it paused (e.g. a
    mid-task overview) and silently shrinking the next turn's LLM history. Rebuild it the
    way the live loop would: join this turn's assistant contents (everything after the
    last user message) as paragraphs. Prior turns (history before that user message) are
    their own messages and are excluded.
    """
    start = 0
    for i in range(len(transcript) - 1, -1, -1):
        if transcript[i].role == "user":
            start = i + 1
            break
    acc = ""
    for msg in transcript[start:]:
        if msg.role == "assistant" and msg.content:
            acc = join_segments(acc, msg.content)
    return acc


def _finish_resume_turn(
    *,
    message_id: str,
    captain_run_id: str,
    captain_state,
    pre_pause_content: str,
    delegate_tool: DelegateTool,
    revise_tool: ReviseTool,
    debate_tool: DebateTool,
    profile,
    citations: list[dict],
    sink: EventSink,
) -> dict:
    """Bill + close a resumed turn whose CEO loop ran (plan_review / ask_user continue).

    The whole turn bills once here: the captain's resume round + any delegated
    workers' usage (seeds + tail, folded by ``resume_plan``) + any revise. Mirrors
    :func:`run_chat_pipeline`'s tail (usage roll-up, per-run ledger, citations,
    message_end), returning the same result shape for the service to persist.
    """
    final_content = join_segments(pre_pause_content, captain_state.content)
    final_reasoning = captain_state.reasoning
    rounds = captain_state.rounds
    turn_usage = (
        TokenUsage.from_usage_dict(captain_state.usage)
        + TokenUsage.from_usage_dict(delegate_tool.usage)
        + TokenUsage.from_usage_dict(revise_tool.usage)
        + TokenUsage.from_usage_dict(debate_tool.usage)
    )
    finish = captain_state.finish_override or (
        FinishReason.END_TURN if rounds < profile.max_rounds else FinishReason.MAX_ROUNDS
    )
    captain_cost = captain_run_cost_from_state(captain_run_id, captain_state)
    cost_runs = [
        asdict(captain_cost),
        *(asdict(r) for r in delegate_tool.run_ledger),
        *(asdict(r) for r in revise_tool.run_ledger),
        *(asdict(r) for r in debate_tool.run_ledger),
    ]
    turn_cost = aggregate_cost(cost_runs)
    merge_citations(citations, delegate_tool.citations)
    merge_citations(citations, revise_tool.citations)
    merge_citations(citations, debate_tool.citations)
    stray_markers = out_of_range_markers(final_content, len(citations))
    if stray_markers:
        logger.warning(
            "citations.out_of_range",
            message_id=message_id,
            markers=stray_markers,
            citation_count=len(citations),
        )
    if citations:
        sink.emit(citations_event(citations))
    sink.emit(
        message_end(
            finish,
            input_tokens=turn_usage.input_tokens,
            output_tokens=turn_usage.output_tokens,
            reasoning_tokens=turn_usage.reasoning_tokens,
            cache_hit_tokens=turn_usage.cache_hit_tokens,
            cache_miss_tokens=turn_usage.cache_miss_tokens,
            rounds=rounds,
            cost=turn_cost,
        )
    )
    runs = _build_runs_payload(sink, finish)
    return {
        "message_id": message_id,
        "content": final_content,
        "reasoning_content": final_reasoning,
        "input_tokens": turn_usage.input_tokens,
        "output_tokens": turn_usage.output_tokens,
        "reasoning_tokens": turn_usage.reasoning_tokens,
        "cache_hit_tokens": turn_usage.cache_hit_tokens,
        "cache_miss_tokens": turn_usage.cache_miss_tokens,
        "rounds": rounds,
        "finish_reason": finish,
        "citations": citations,
        "runs": runs,
        "cost_runs": cost_runs,
    }


def _finish_terminal_resume(
    *, message_id: str, pre_pause_content: str, closing: str, sink: EventSink
) -> dict:
    """Close a resumed ask_user turn that the user STOPPED (结构化挂起 2b terminal).

    No CEO round ran — the closing note is the whole reply (the engine's
    terminal-effect semantics, replayed on resume). The pre-pause CEO round that
    raised the ask_user was never billed (the turn paused before persistence), and a
    stop runs nothing new, so this turn bills nothing — consistent with the「paused
    before persist = never billed」model. The seeded journal (checkpoint_required) +
    the emitted ``checkpoint_resolved`` persist so a reload replays the settled card.
    """
    finish = FinishReason.END_TURN
    sink.emit(message_end(finish, rounds=0))
    runs = _build_runs_payload(sink, finish)
    return {
        "message_id": message_id,
        "content": join_segments(pre_pause_content, closing),
        "reasoning_content": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 0,
        "rounds": 0,
        "finish_reason": finish,
        "citations": [],
        "runs": runs,
        "cost_runs": [],
    }
