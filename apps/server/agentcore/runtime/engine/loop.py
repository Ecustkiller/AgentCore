"""ReAct main loop: turn control, LLM rounds, tool execution, governance."""

from collections.abc import Callable
from dataclasses import replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.llm.config import ModelProfile, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage, TokenUsage
from agentcore.runtime.approvals import ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    content_reset,
    error_event,
    reasoning_delta,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

from .directive import Continue, Finalize, LoopDirective, Return, Rework, SwitchModel
from .finalize import force_finalize
from .governance import (
    apply_circuit_breaker,
    classify_investigation_tools,
    create_loop_controller,
    decide_llm_failure,
    govern_after_tools,
    resolve_openai_tool_defs,
)
from .outcome import RoundOutcome
from .round import (
    LlmRoundFailure,
    apply_finish_guard_rework,
    decide_no_tool_round,
    record_round_start,
    run_llm_round,
)
from .segments import join_segments
from .tool_exec import execute_tools

logger = get_logger(__name__)


async def react_loop(
    *,
    messages: list[LLMMessage],
    llm: DeepSeekProvider,
    tools: ToolRegistry,
    sink: EventSink,
    tool_context: ToolContext,
    profile: ModelProfile | None = None,
    allowed_tool_names: list[str] | None = None,
    on_content: Callable[[str], None] | None = None,
    on_reasoning: Callable[[str], None] | None = None,
    on_tool_progress: Callable[[str, int], None] | None = None,
    on_reset: Callable[[], None] | None = None,
    raise_on_error: bool = False,
    citation_sink: list[dict[str, Any]] | None = None,
    annotate_citations: bool = True,
    approval_gate: ApprovalGate | None = None,
    usage_sink: list[TokenUsage] | None = None,
    finish_override_sink: list[FinishReason] | None = None,
    run_id: str = "",
    role: str = "",
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
    ``on_reset`` mirrors that redirection for the finish_guard rework reset: the
    default clears the CEO bubble (``content_reset``); a worker passes ``on_reset``
    to clear its run card (``run_output_reset``) instead — so the rewrite replaces
    the discarded draft cleanly on whichever surface streamed it (统一底线).
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
    keeps returning empty responses even after the fallback retry, or ``UNPRODUCTIVE``
    when it early-stops a run of all-tools-failed-no-content rounds (B2). Cleared on
    entry; left empty on a normal finish (one channel, since a run takes at most one
    such terminal path).

    ``run_id`` / ``role`` scope the execution-level facts (§18.3) this loop records
    into the turn's ambient :data:`~agentcore.runtime.facts.current_fact_log`
    (round_boundary / llm_call / note) — captain vs worker, so a multi-agent turn's
    facts split per run. They default to empty (a standalone loop / test records
    facts with no scope, or none at all when no log is bound).
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
    emit_reset = on_reset or (lambda: sink.emit(content_reset()))

    total_usage = TokenUsage()
    final_content = ""
    final_reasoning = ""

    investigation_tools = classify_investigation_tools(tools, allowed_tool_names)
    controller = create_loop_controller(investigation_tools)
    active_model: str | None = None
    finish_guard_reworks = 0

    for round_idx in range(profile.max_rounds):
        logger.debug("react.round_start", round=round_idx, messages=len(messages))
        record_round_start(round_idx=round_idx, run_id=run_id, role=role)
        content_before_round = final_content

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
        )

        if isinstance(round_result, LlmRoundFailure):
            # Hard LLM failure (non-raising path): the provider already exhausted its
            # network retries. Walk the engine-level fallback ladder — escalate to the
            # fallback model once, else end on ERROR/DEGRADED (error surfaced below, in
            # the Return arm, so a recovered fallback retry shows the user nothing).
            outcome = RoundOutcome(
                content="",
                reasoning="",
                usage=None,
                llm_failed=True,
                error_code=round_result.error_code,
                error_message=round_result.error_message,
            )
            directive: LoopDirective = decide_llm_failure(
                profile=profile, active_model=active_model, final_content=final_content
            )
        else:
            usage = round_result.usage
            if usage:
                total_usage = total_usage + usage
            if usage_sink is not None:
                usage_sink[:] = [total_usage]

            if round_result.content:
                final_content = join_segments(final_content, round_result.content)
            if round_result.reasoning:
                final_reasoning += round_result.reasoning

            outcome = RoundOutcome(
                content=round_result.content,
                reasoning=round_result.reasoning,
                usage=usage,
                tool_calls=round_result.tool_calls,
            )
            controller.note_empty_round(outcome.is_empty)

            if not outcome.has_tool_calls:
                directive = decide_no_tool_round(
                    outcome,
                    final_content=final_content,
                    controller=controller,
                    profile=profile,
                    active_model=active_model,
                    annotate_citations=annotate_citations,
                    citation_sink=citation_sink,
                    finish_guard_reworks=finish_guard_reworks,
                )
            else:
                messages.append(
                    LLMMessage(
                        role="assistant",
                        content=outcome.content or None,
                        tool_calls=outcome.tool_calls,
                        reasoning_content=outcome.reasoning or None,
                    )
                )
                tool_results, terminal, attempts = await execute_tools(
                    outcome.tool_calls,
                    tools,
                    tool_context,
                    sink,
                    approval_gate=approval_gate,
                    citation_sink=citation_sink,
                    annotate_citations=annotate_citations,
                    run_id=run_id,
                )
                messages.extend(tool_results)
                outcome = replace(
                    outcome,
                    tool_results=tool_results,
                    attempts=attempts,
                    terminal_handoff=(terminal.final_text or "")
                    if terminal is not None
                    else None,
                )

                if terminal is not None:
                    usage_meta = terminal.metadata or {}
                    total_usage = total_usage + TokenUsage(
                        input_tokens=usage_meta.get("input_tokens", 0),
                        output_tokens=usage_meta.get("output_tokens", 0),
                        reasoning_tokens=usage_meta.get("reasoning_tokens", 0),
                        cache_hit_tokens=usage_meta.get("cache_hit_tokens", 0),
                        cache_miss_tokens=usage_meta.get("cache_miss_tokens", 0),
                    )
                    directive = Return(extra_content=outcome.terminal_handoff or "")
                else:
                    controller.record(outcome.attempts)
                    breaker = apply_circuit_breaker(
                        controller,
                        messages=messages,
                        run_id=run_id,
                        round_idx=round_idx,
                        disabled_tools=disabled_tools,
                    )
                    if breaker.refresh_tool_defs:
                        tool_defs = _resolve_tool_defs()
                    directive = govern_after_tools(
                        outcome,
                        controller,
                        messages=messages,
                        round_idx=round_idx,
                        run_id=run_id,
                        breaker_message=breaker.message,
                    )

        match directive:
            case Return(finish_reason=fr, extra_content=extra):
                if outcome.llm_failed:
                    sink.emit(
                        error_event(outcome.error_code or "", outcome.error_message or "")
                    )
                if fr is not None and finish_override_sink is not None:
                    finish_override_sink.append(fr)
                content = join_segments(final_content, extra) if extra else final_content
                return content, final_reasoning, total_usage, round_idx + 1
            case Finalize(reason=reason, finish_reason=fr):
                if fr is not None and finish_override_sink is not None:
                    finish_override_sink.append(fr)
                return await force_finalize(
                    messages=messages,
                    llm=llm,
                    profile=profile,
                    emit_content=emit_content,
                    emit_reasoning=emit_reasoning,
                    final_content=final_content,
                    final_reasoning=final_reasoning,
                    total_usage=total_usage,
                    rounds=round_idx + 1,
                    reason=reason,
                    run_id=run_id,
                )
            case SwitchModel(model=model):
                active_model = model
                continue
            case Rework():
                final_content, finish_guard_reworks = apply_finish_guard_rework(
                    messages=messages,
                    emit_reset=emit_reset,
                    final_content=final_content,
                    content_before_round=content_before_round,
                    round_idx=round_idx,
                    run_id=run_id,
                    annotate_citations=annotate_citations,
                    citation_sink=citation_sink,
                    finish_guard_reworks=finish_guard_reworks,
                )
                continue
            case Continue():
                continue

    logger.warning("engine.max_rounds_exhausted", rounds=profile.max_rounds)
    return await force_finalize(
        messages=messages,
        llm=llm,
        profile=profile,
        emit_content=emit_content,
        emit_reasoning=emit_reasoning,
        final_content=final_content,
        final_reasoning=final_reasoning,
        total_usage=total_usage,
        rounds=profile.max_rounds,
        reason="max_rounds",
        run_id=run_id,
    )
