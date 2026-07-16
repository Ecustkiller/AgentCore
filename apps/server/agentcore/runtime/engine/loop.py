"""ReAct main loop: turn control, LLM rounds, tool execution, governance."""

from collections.abc import Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any

from agentcore.core.error_codes import ErrorCode
from agentcore.core.logging import get_logger
from agentcore.llm.profiles import ProfileParams, get_profile
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    content_reset,
    reasoning_delta,
)
from agentcore.runtime.loop_controller import LoopController
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

from .ceiling import ceiling_finalize
from .directive import LoopDirective
from .directive_apply import apply_loop_directive
from .governance import (
    classify_investigation_tools,
    coordination_injection_has_all_completed,
    create_loop_controller,
    decide_llm_failure,
    maybe_inject_audit_gate,
    resolve_openai_tool_defs,
)
from .outcome import RoundOutcome
from .round import (
    LlmRoundFailure,
    decide_no_tool_round,
    record_round_start,
    run_llm_round,
)
from .segments import join_segments
from .soft_gates import maybe_soft_gate_no_tool_return
from .tool_round import handle_tool_calls_round

logger = get_logger(__name__)


@dataclass
class CaptainLoopMirror:
    """Live captain-loop mirror for suspension capture (G4 turn_paused).

    Published only while ``react_loop(..., role="captain")`` is running. Holds a
    reference to the run's :class:`LoopController` plus the two content
    accumulators a suspending face needs (ask_user → ``content_before_round``;
    delegate / team_preview / plan_review → ``final_content``).
    """

    controller: LoopController
    content_before_round: str = ""
    final_content: str = ""


current_captain_loop: ContextVar[CaptainLoopMirror | None] = ContextVar(
    "current_captain_loop", default=None
)


def sync_captain_loop_mirror(
    *,
    content_before_round: str | None = None,
    final_content: str | None = None,
) -> None:
    """Update the published captain mirror in place (no-op when unset / non-captain)."""
    mirror = current_captain_loop.get()
    if mirror is None:
        return
    if content_before_round is not None:
        mirror.content_before_round = content_before_round
    if final_content is not None:
        mirror.final_content = final_content


async def react_loop(
    *,
    messages: list[LLMMessage],
    llm: OpenAICompatibleProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_context: ToolContext,
    profile: ProfileParams | None = None,
    turn_model: str | None = None,
    allowed_tool_names: list[str] | None = None,
    on_content: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
    on_tool_progress: Callable[[str, int], None] | None = None,
    on_reset: Callable[[str], None] | None = None,
    on_round_begin: Callable[[], list[LLMMessage]] | None = None,
    round_sink: list[int] | None = None,
    raise_on_error: bool = False,
    citation_sink: list[dict[str, Any]] | None = None,
    annotate_citations: bool = True,
    approval_gate: ApprovalGate | None = None,
    usage_sink: list[TokenUsage] | None = None,
    finish_override_sink: list[FinishReason] | None = None,
    run_id: str = "",
    role: str = "",
    deliverable_only: bool = False,
    supports_tools: bool | None = None,
    gate_escalation_sink: list[dict[str, Any]] | None = None,
    token_budget: int = 0,
    controller_seed: Mapping[str, Any] | None = None,
) -> tuple[str, str, TokenUsage, int]:
    """Run the ReAct loop.

    Returns ``(final_content, final_reasoning, usage, rounds)`` where ``usage`` is
    the turn's :class:`TokenUsage` summed across every round (carrying the
    cache_hit/cache_miss split so cost stays honest on multi-turn chats — a single
    object instead of loose ints). ``final_reasoning`` is the concatenated
    thinking text across all rounds (empty when thinking is disabled), mirroring
    what was streamed via ``reasoning_delta`` so it can be persisted for replay.

    The ``profile`` drives both the model params and the round budget
    (``profile.max_rounds``); it defaults to the chat profile. By
    default content/reasoning deltas are emitted as conversation events
    (single-agent path). A caller running a multi-agent run passes ``on_content``
    /``on_reasoning`` to redirect text into ``run_output_delta`` instead, and
    ``on_tool_progress`` to surface a worker's tool-call ARGUMENT streaming
    (``(tool_name, cumulative_chars)``, throttled) — the only live signal during a
    long file write, which is neither content nor reasoning.
    ``on_reset`` mirrors that redirection for every draft-discard reset: the
    default clears the CEO bubble (``content_reset``); a worker passes ``on_reset``
    to clear its run card (``run_output_reset``) instead — so the rewrite replaces
    the discarded draft cleanly on whichever surface streamed it (统一底线). It takes
    the ``ResetReason`` (finish_guard / retry / soft_gate / narration / ask_user) —
    each emit site states WHY, and folds render the rework chip only for finish_guard.
    ``on_round_begin`` (when provided) is called at the top of every round AFTER the
    first; the messages it returns are appended to the window before that round's LLM
    call. A generic「inject context that accrued while the run was working」hook — a
    delegated worker wires it to pull teammates' freshly-posted 便签 (§2.2 通·便签墙)
    so the team builds on each other's evolving work; ``None`` (CEO / solo / tests) is a
    no-op. The engine only appends what it returns — the caller owns the semantics.
    ``allowed_tool_names`` filters which tools the model may call (``None`` = all,
    ``[]`` = none). Tool execution events always go to the sink. When
    ``citation_sink`` is provided, web sources consulted by research tools are
    aggregated into it (de-duped, capped) for the caller to surface/persist.
    ``annotate_citations`` (default True, CEO chat path) also folds each source's
    assigned number back into the tool output so the model cites by a card-aligned
    number (A2). Delegated workers pass ``annotate_citations=False``: their sources
    are still collected (for the turn's shared source card — see DelegateTool /
    pipeline) but NOT numbered into the worker's text, since a worker's local
    numbering would be re-ordered when merged into the turn card and would mislead.
    ``approval_gate`` (CEO chat path only; ``None`` for delegated workers) pauses
    GRANTABLE tool calls until the user authorizes them — a denial is fed back to
    the model as a tool result so it can adapt.
    ``usage_sink`` (when provided) mirrors the running ``total_usage`` after each
    completed round, so a caller that catches an exception can still bill the
    tokens consumed before the failure (B-deep 失败计费): on ``raise_on_error`` the
    accumulated usage is otherwise lost inside this frame when a mid-loop round
    raises. It is cleared on entry and only ever holds the latest cumulative total
    (a single-element list); on a normal return the caller uses the returned usage
    instead.
    ``finish_override_sink`` (when provided, CEO captain path) is an out-param
    mirroring the ``usage_sink`` idiom: it carries a single :class:`FinishReason`
    the caller should stamp on the turn instead of the rounds-derived default
    (``end_turn`` / ``max_rounds``). The loop sets it to ``DEGRADED`` when the model
    keeps returning empty responses past the threshold, or ``UNPRODUCTIVE``
    when it early-stops a run of all-tools-failed-no-content rounds (B2). Cleared on
    entry; left empty on a normal finish (one channel, since a run takes at most one
    such terminal path).

    ``run_id`` / ``role`` scope the execution-level facts (§8.3) this loop records
    into the turn's ambient :data:`~agentcore.runtime.facts.current_fact_log`
    (round_boundary / llm_call / note) — captain vs worker, so a multi-agent turn's
    facts split per run. They default to empty (a standalone loop / test records
    facts with no scope, or none at all when no log is bound).

    ``deliverable_only`` makes the RETURNED ``final_content`` the 交付正文 only — the
    prose a round streams BEFORE a *non-terminal* tool call is treated as PROCESS
    narration ("我先查一下" / an acknowledgement of an injected ``[系统提示]`` steer)
    and rolled back off the accumulator (mirroring the finish_guard ``Rework``
    rollback), so it never accrues into the persisted product / next-turn history /
    CEO synthesis input. It is always journaled per round (llm_call fact → 旁白入
    journal). Two display disciplines by channel架构:

    - CEO captain (``on_reset`` is None → default ``content_delta`` / ``content_reset``):
      the narration STAYS streamed + visible in the SEPARATE process timeline
      (透明可见); only ``messages.content`` (旁路 conformance) is trimmed. No reset.
    - worker / debater / revision (``on_reset`` routes ``run_output_reset``, and the
      card replays from the ``message_final`` fact — a SINGLE display+data channel):
      the narration rollback ALSO emits ``run_output_reset`` to clear the streamed
      draft off the card, so 直播 == the rolled-back deliverable == 重载 (synthesized
      from ``message_final``) — the conformance invariant.

    Terminal rounds (handoff / suspend checkpoints other than blocking ``ask_user``)
    KEEP their pre-tool text — that IS the deliverable at that boundary. Blocking
    ``ask_user`` absorbs same-round prose into the card instead (see
    ``ask_user_absorb``). Default ``False`` leaves the
    accumulation byte-identical to before (standalone loops / tests).

    ``gate_escalation_sink`` (Worker routing Phase 1): when provided, each tool round
    runs the Escalation Gate after ``execute_tools``; scheme-layer signals are appended
    here and emitted as ``run_escalation_gate``. CEO / solo leave it ``None`` (gate inert).

    ``token_budget`` (Worker hard ceiling · loose backstop): a cumulative
    input+output token cap for the whole run, checked at the TOP of each round. Once
    ``total_usage.total_tokens`` reaches it the loop stops and force-finalizes — the
    backstop against a worker blowing past the configured unified ceiling. The
    terminal finalize (this AND ``max_rounds`` exhaustion) is gate-routed by run
    health (``controller.is_thrashing()``): an on-track run delivers normally; a
    thrashing worker finishes DEGRADED and emits an observable ``escalation_raised``
    signal (no auto re-decompose — the CEO may voluntarily replan). ``0`` (CEO /
    solo / tests / ceiling disabled) disables the backstop, leaving the run bounded
    only by ``profile.max_rounds``.

    ``controller_seed`` (resume path): optional JSON-safe latch snapshot from a prior
    ``turn_paused.controller``; omitted on a fresh turn (behaviour unchanged).
    """
    profile = profile or get_profile("chat")
    if usage_sink is not None:
        usage_sink.clear()
    if finish_override_sink is not None:
        finish_override_sink.clear()

    disabled_tools: set[str] = set()

    def _resolve_tool_defs() -> list[dict[str, Any]] | None:
        return resolve_openai_tool_defs(tools, allowed_tool_names, disabled_tools)

    tool_defs = _resolve_tool_defs()

    emit_content = on_content or (lambda delta: sink.emit(content_delta(delta)))
    emit_reasoning = on_reasoning or (lambda delta: sink.emit(reasoning_delta(delta)))
    emit_reset = on_reset or (lambda reason: sink.emit(content_reset(reason)))

    total_usage = TokenUsage()
    final_content = ""
    final_reasoning = ""

    profile = profile or get_profile("chat")
    base_model = turn_model
    if base_model is None:
        from agentcore.config import settings

        logger.warning(
            "react_loop.missing_turn_model",
            fallback=settings.platform_model,
        )
        base_model = settings.platform_model

    investigation_tools = classify_investigation_tools(tools, allowed_tool_names)
    controller = create_loop_controller(investigation_tools, seed=controller_seed)
    active_model: str | None = base_model
    finish_guard_reworks = 0
    ceiling_reason = "max_rounds"
    round_idx = 0

    # G4: publish captain live mirror only when role=="captain" — NOT via
    # deliverable_only (workers / debaters also set that flag and nest under the
    # captain Task; gating on it would clobber the captain mirror).
    captain_token = None
    if role == "captain":
        captain_token = current_captain_loop.set(CaptainLoopMirror(controller=controller))

    try:
        for round_idx in range(profile.max_rounds):
            # Loose token backstop (Worker 硬顶): stop BEFORE starting a round once the run's
            # cumulative input+output tokens reach the ceiling, so a runaway overshoots by at
            # most one round instead of grinding on (根因: 之前没人比对这个累计数). ``total_usage``
            # is updated at each round's end, so this reflects rounds 0..round_idx-1. 0 =
            # disabled (CEO / solo / tests → bounded only by max_rounds).
            if token_budget > 0 and total_usage.total_tokens >= token_budget:
                ceiling_reason = "token_budget"
                logger.warning(
                    "engine.token_budget_exhausted",
                    run_id=run_id,
                    role=role,
                    tokens=total_usage.total_tokens,
                    token_budget=token_budget,
                    round=round_idx,
                )
                break
            if round_sink is not None:
                round_sink[:] = [round_idx + 1]
            logger.debug("react.round_start", round=round_idx, messages=len(messages))
            record_round_start(round_idx=round_idx, run_id=run_id, role=role)
            content_before_round = final_content
            # Update point 1/3: round start (content_before_round + current final_content).
            # Gated on role — nested worker loops must not mutate the captain mirror.
            if role == "captain":
                sync_captain_loop_mirror(
                    content_before_round=content_before_round,
                    final_content=final_content,
                )
            # 团队便签墙 推增量 (§2.2 通): before each step AFTER the first, inject context that
            # accrued WHILE this run was working — e.g. teammates' freshly-posted notes — so the
            # team builds on each other's evolving work instead of each guessing in isolation.
            # The opening round already carries the run's assembled context, so the hook starts at
            # round 1 (which also avoids two back-to-back user messages on the very first request).
            # Generic by design: the engine only appends what the hook returns; the caller owns the
            # semantics (引擎纯化), mirroring on_content / on_reasoning.
            if round_idx and on_round_begin is not None:
                messages.extend(on_round_begin())

            # CEO 协调模式 Phase 2: only the captain consumes team events (workers share
            # the ContextVar but must not block on the coordination queue).
            if role == "captain":
                from agentcore.runtime.coordination.wait import await_coordination_injection

                coord_msgs = await await_coordination_injection(messages)
                if coord_msgs:
                    messages.extend(coord_msgs)
                    # Soft audit-gate (all_completed): remind before synthesis / wrap-up
                    # while CEO is still in coordination — not only on no-tool Return.
                    if coordination_injection_has_all_completed(coord_msgs):
                        maybe_inject_audit_gate(
                            controller,
                            messages=messages,
                            run_id=run_id,
                            round_idx=round_idx,
                            role=role,
                        )

            round_result = await run_llm_round(
                llm=llm,
                profile=profile,
                messages=messages,
                investigation_tools=investigation_tools,
                tool_defs=tool_defs,
                active_model=active_model,
                emit_content=emit_content,
                emit_reasoning=emit_reasoning,
                on_tool_progress=on_tool_progress,
                round_idx=round_idx,
                run_id=run_id,
                raise_on_error=raise_on_error,
                on_reset=emit_reset,
            )

            if isinstance(round_result, LlmRoundFailure):
                # Hard LLM failure (non-raising path): the provider already exhausted its
                # network retries. End on ERROR/DEGRADED (error surfaced in the Return arm).
                outcome = RoundOutcome(
                    content="",
                    reasoning="",
                    usage=None,
                    llm_failed=True,
                    error_code=round_result.error_code,
                    error_message=round_result.error_message,
                    error_context=round_result.error_context,
                )
                directive: LoopDirective = decide_llm_failure(final_content=final_content)
            elif round_result.aborted:
                # Post-commit disconnect / stall: keep the partial prose and finish
                # DEGRADED (resume entry stays available via existing infrastructure).
                usage = round_result.usage
                if usage:
                    total_usage = total_usage + usage
                if usage_sink is not None:
                    usage_sink[:] = [total_usage]
                if round_result.content:
                    final_content = join_segments(final_content, round_result.content)
                    # Update point 2/3: prose join.
                    if role == "captain":
                        sync_captain_loop_mirror(final_content=final_content)
                if round_result.reasoning:
                    final_reasoning += round_result.reasoning
                outcome = RoundOutcome(
                    content=round_result.content,
                    reasoning=round_result.reasoning,
                    usage=usage,
                    llm_failed=True,
                    error_code=ErrorCode.LLM_ERROR,
                    error_message="模型响应中断，已保留已生成内容，可继续。",
                )
                directive = decide_llm_failure(final_content=final_content)
            else:
                usage = round_result.usage
                if usage:
                    total_usage = total_usage + usage
                if usage_sink is not None:
                    usage_sink[:] = [total_usage]

                if round_result.content:
                    final_content = join_segments(final_content, round_result.content)
                    # Update point 2/3: prose join.
                    if role == "captain":
                        sync_captain_loop_mirror(final_content=final_content)
                if round_result.reasoning:
                    final_reasoning += round_result.reasoning

                outcome = RoundOutcome(
                    content=round_result.content,
                    reasoning=round_result.reasoning,
                    usage=usage,
                    tool_calls=round_result.tool_calls,
                    empty_diagnosis=round_result.empty_diagnosis,
                    empty_raw_preview=round_result.empty_raw_preview,
                )
                controller.note_empty_round(outcome.is_empty)

                if not outcome.has_tool_calls:
                    directive = decide_no_tool_round(
                        outcome,
                        final_content=final_content,
                        controller=controller,
                        annotate_citations=annotate_citations,
                        citation_sink=citation_sink,
                        finish_guard_reworks=finish_guard_reworks,
                        tools_offered=tool_defs is not None,
                        supports_tools=supports_tools,
                    )
                    # Soft team-gate (b) / Soft audit-gate: captain wrap-up without
                    # delegate — discard the draft, inject nudge, continue.
                    directive, rolled = maybe_soft_gate_no_tool_return(
                        directive=directive,
                        outcome=outcome,
                        controller=controller,
                        messages=messages,
                        role=role,
                        round_idx=round_idx,
                        run_id=run_id,
                        content_before_round=content_before_round,
                        emit_reset=emit_reset,
                    )
                    if rolled is not None:
                        final_content = rolled
                else:
                    tool_round = await handle_tool_calls_round(
                        outcome=outcome,
                        messages=messages,
                        tools=tools,
                        tool_context=tool_context,
                        sink=sink,
                        approval_gate=approval_gate,
                        citation_sink=citation_sink,
                        annotate_citations=annotate_citations,
                        run_id=run_id,
                        role=role,
                        gate_escalation_sink=gate_escalation_sink,
                        deliverable_only=deliverable_only,
                        on_reset=on_reset,
                        emit_reset=emit_reset,
                        content_before_round=content_before_round,
                        final_content=final_content,
                        round_result_content=round_result.content,
                        total_usage=total_usage,
                        controller=controller,
                        allowed_tool_names=allowed_tool_names,
                        disabled_tools=disabled_tools,
                        round_idx=round_idx,
                    )
                    outcome = tool_round.outcome
                    directive = tool_round.directive
                    final_content = tool_round.final_content
                    total_usage = tool_round.total_usage
                    if tool_round.tool_defs_changed:
                        tool_defs = tool_round.tool_defs

            applied = await apply_loop_directive(
                directive=directive,
                outcome=outcome,
                messages=messages,
                llm=llm,
                tools=tools,
                tool_context=tool_context,
                sink=sink,
                profile=profile,
                active_model=active_model,
                base_model=base_model,
                allowed_tool_names=allowed_tool_names,
                disabled_tools=disabled_tools,
                emit_content=emit_content,
                emit_reasoning=emit_reasoning,
                emit_reset=emit_reset,
                final_content=final_content,
                final_reasoning=final_reasoning,
                total_usage=total_usage,
                round_idx=round_idx,
                run_id=run_id,
                role=role,
                finish_override_sink=finish_override_sink,
                approval_gate=approval_gate,
                citation_sink=citation_sink,
                annotate_citations=annotate_citations,
                gate_escalation_sink=gate_escalation_sink,
                controller=controller,
                content_before_round=content_before_round,
                finish_guard_reworks=finish_guard_reworks,
            )
            if applied.action == "return":
                return (
                    applied.content,
                    applied.reasoning,
                    applied.usage or total_usage,
                    applied.rounds,
                )
            final_content = applied.final_content
            final_reasoning = applied.final_reasoning
            if applied.total_usage is not None:
                total_usage = applied.total_usage
            finish_guard_reworks = applied.finish_guard_reworks
            if applied.tool_defs_changed:
                tool_defs = applied.tool_defs
            continue

        return await ceiling_finalize(
            messages=messages,
            llm=llm,
            profile=profile,
            active_model=active_model,
            base_model=base_model,
            tools=tools,
            allowed_tool_names=allowed_tool_names,
            disabled_tools=disabled_tools,
            emit_content=emit_content,
            emit_reasoning=emit_reasoning,
            emit_reset=emit_reset,
            final_content=final_content,
            final_reasoning=final_reasoning,
            total_usage=total_usage,
            ceiling_reason=ceiling_reason,
            round_idx=round_idx,
            role=role,
            run_id=run_id,
            token_budget=token_budget,
            controller=controller,
            tool_context=tool_context,
            sink=sink,
            finish_override_sink=finish_override_sink,
            gate_escalation_sink=gate_escalation_sink,
        )
    finally:
        if captain_token is not None:
            current_captain_loop.reset(captain_token)
