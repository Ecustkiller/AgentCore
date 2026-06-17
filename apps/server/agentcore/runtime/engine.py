"""ReAct main loop: turn control, LLM calls, tool execution.

Single-agent ReAct loop for MVP:
  1. Build messages (system + history + user)
  2. Call LLM (streaming)
  3. If tool_calls → execute tools → append results → loop
  4. If text response → done

All intermediate events are emitted to an EventSink for SSE delivery.
"""

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any

from agentcore.config import settings
from agentcore.core.errors import AgentCoreError
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile, build_request, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.observability import log_llm_call
from agentcore.llm.protocol import (
    LLMMessage,
    LLMRequest,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
)
from agentcore.runtime.approvals import ApprovalDecision, ApprovalGate
from agentcore.runtime.citations import annotate_tool_citations, merge_citations
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    error_event,
    reasoning_delta,
    tool_use_end,
    tool_use_start,
)
from agentcore.runtime.facts import (
    LlmCallFact,
    NoteFact,
    RoundBoundaryFact,
    ToolCallFact,
    record_turn_fact,
)
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    ToolAttempt,
    fingerprint_tool_call,
    progress_review_prompt,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_MAX_PARALLEL_TOOLS = 5

# Tool-call arguments stream as many tiny deltas (a delegate 任务书 / file body =
# thousands of chars). Emit a progress event only when a call's accumulated args grow
# by ≥ this many chars (plus once when the tool name is first known) — throttling the
# tick that drives the「正在生成 {工具} · N 字」line (captain bubble via tool_progress,
# worker node via run_tool_progress).
#
# Trade-off — it's a char step, so #events = args_len / STEP and the counter jumps by
# STEP each tick, *independent of stream speed*:
#   • smaller → 更跟手 (counter climbs smoothly, feels live) but more SSE events →
#     more store writes / bubble re-renders, and short calls (a tiny str_replace)
#     emit ticks they don't need;
#   • larger → cheaper but the number lurches / lags on a long task book.
# 64 puts a typical DeepSeek arg stream (~150–300 chars/s) at ~3–5 ticks/s — clearly
# alive without flooding — and ≈ one text line per tick reads as "another line
# written". Each event is a tiny {tool_name, chars} + a one-field store patch, so even
# a 50KB write (≈800 ticks over its whole duration) is comfortably cheap; tune here if
# the bubble ever feels jittery (raise) or laggy (lower).
_TOOL_PROGRESS_STEP = 64


# Injected when convergence governance forces a tool-free answer (a stuck loop
# trips a hard finalize, or the round budget is exhausted mid-tool-call).
_FINALIZE_INSTRUCTION = (
    "[系统提示] 请停止使用任何工具，基于目前已掌握的全部信息，立即给出你最好的最终答案。"
)


# Tool categories whose calls are NOT bounded by the engine timeout backstop (B1):
# they legitimately block for minutes on a sub-run or the user, and are bounded by
# their own lifecycle instead — delegate/revise drive sub-DAGs (each constituent
# tool call is itself bounded), ask_user waits on the user behind its own checkpoint
# timeout. A flat ceiling here would wrongly kill a legitimate long wait.
_TIMEOUT_EXEMPT_CATEGORIES = frozenset(
    {ToolCategory.ORCHESTRATION, ToolCategory.INTERACTION}
)


def resolve_tool_timeout(schema: ToolSchema) -> float | None:
    """The engine-level wall-clock ceiling (seconds) for one call of this tool.

    ``None`` ⇒ no engine backstop (the tool manages its own lifecycle). Precedence:
    an explicit ``schema.timeout_seconds`` wins; else the tool's category decides —
    ORCHESTRATION / INTERACTION are exempt (``None``), EXECUTION gets the higher
    execution ceiling (it runs code), everything else the default. This is a coarse
    safety net layered above each tool's own finer timeout, never a replacement (B1).
    """
    if schema.timeout_seconds is not None:
        return schema.timeout_seconds
    if schema.category in _TIMEOUT_EXEMPT_CATEGORIES:
        return None
    if schema.category is ToolCategory.EXECUTION:
        return settings.tool_execution_timeout_seconds
    return settings.tool_default_timeout_seconds


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
    # Reset any caller-provided usage mirror so it reflects only this loop's spend
    # (callers reuse one list across contract-retry attempts).
    if usage_sink is not None:
        usage_sink.clear()
    if finish_override_sink is not None:
        finish_override_sink.clear()

    # Tools the circuit breaker (B2) has retired for the rest of this run. Recomputing
    # the openai defs from the current allow-list minus this set lets a wedged tool be
    # removed mid-run without rebuilding the whole loop (empty result → tool_choice
    # falls back to "none", forcing a text answer).
    disabled_tools: set[str] = set()

    def _resolve_tool_defs() -> list[dict[str, Any]] | None:
        if allowed_tool_names is None:
            candidates = tools.names if tools.count > 0 else []
        else:
            candidates = list(allowed_tool_names)
        candidates = [name for name in candidates if name not in disabled_tools]
        if not candidates:
            return None
        return tools.get_openai_definitions(candidates) or None

    tool_defs = _resolve_tool_defs()

    emit_content = on_content or (lambda delta: sink.emit(content_delta(delta)))
    emit_reasoning = on_reasoning or (lambda delta: sink.emit(reasoning_delta(delta)))

    total_usage = TokenUsage()
    final_content = ""
    final_reasoning = ""

    # Per-run convergence governance: detects mechanical loops outside the model.
    controller = LoopController(
        empty_threshold=settings.engine_empty_response_threshold,
        tool_failure_warn=settings.engine_tool_failure_warn,
        tool_failure_disable=settings.engine_tool_failure_disable,
        unproductive_threshold=settings.engine_unproductive_threshold,
        reflection_start_round=settings.engine_reflection_start_round,
        reflection_interval=settings.engine_reflection_interval,
    )
    # B2 degraded fallback: the model the next round runs on. None = the profile's
    # own model; set to profile.fallback_model after an empty round to retry once on
    # the stronger model. Sticky for the rest of the run once escalated.
    active_model: str | None = None

    for round_idx in range(profile.max_rounds):
        logger.debug("react.round_start", round=round_idx, messages=len(messages))
        # 执行级事件溯源 (§18.3): mark this ReAct round edge — the seam `round_boundary.
        # fold` later cuts the LLM window / pause snapshot on. No-op outside a turn.
        record_turn_fact(
            RoundBoundaryFact(round_idx=round_idx, run_id=run_id, role=role).to_fact()
        )
        request = build_request(
            profile,
            messages,
            tools=tool_defs,
            tool_choice="auto" if tool_defs else "none",
            model=active_model,
        )

        try:
            round_content, round_reasoning, round_tool_calls, usage = (
                await _stream_llm_round(
                    llm, request, emit_content, emit_reasoning, on_tool_progress
                )
            )
        except Exception as e:
            logger.error("llm.call_failed", round=round_idx, error=str(e))
            if raise_on_error:
                raise
            # AgentCoreError carries a curated, user-facing (zh) message + specific
            # code (e.g. LLM_INSUFFICIENT_BALANCE), so surface those; any other
            # exception is a raw technical string, so show a generic friendly line
            # instead of leaking it into the chat.
            if isinstance(e, AgentCoreError):
                sink.emit(error_event(e.code, e.message))
            else:
                sink.emit(error_event("LLM_ERROR", "出了点问题，请稍后重试。"))
            return final_content, final_reasoning, total_usage, round_idx + 1

        if usage:
            total_usage = total_usage + usage
        # Mirror the cumulative spend so a caller catching a later raise can still
        # bill the rounds that completed (the round that raises returns no usage).
        if usage_sink is not None:
            usage_sink[:] = [total_usage]

        if round_content:
            final_content = join_segments(final_content, round_content)

        if round_reasoning:
            final_reasoning += round_reasoning

        # 执行级事件溯源 (§18.3): record THIS round's LLM output as a fact — content +
        # reasoning_content + tool_calls + usage. Only the output is stored; the input
        # window is the fold of all prior facts (correct-by-construction, no quadratic
        # window duplication). reasoning_content is kept verbatim because DeepSeek
        # thinking mode requires it echoed back on a tool-call round (llm.mdc / §4.3),
        # so a window rebuilt from facts must reproduce it. No-op outside a turn.
        record_turn_fact(
            LlmCallFact(
                run_id=run_id,
                round_idx=round_idx,
                content=round_content,
                reasoning_content=round_reasoning,
                tool_calls=_tool_calls_to_dicts(round_tool_calls),
                usage=usage.as_dict() if usage else {},
                finish_reason="tool_calls" if round_tool_calls else "stop",
            ).to_fact()
        )

        # Per-round trace: tools requested this round + the round's own token split
        # (reasoning_tokens is the key "how hard did it think" signal). `done=True`
        # marks the no-tool round that ends the loop. Inherits the worker's
        # run_id/agent_id/depth (executor log_context) so rounds split per worker.
        logger.info(
            "react.round_end",
            round=round_idx,
            tools=len(round_tool_calls) if round_tool_calls else 0,
            input_tokens=usage.input_tokens if usage else 0,
            output_tokens=usage.output_tokens if usage else 0,
            reasoning_tokens=usage.reasoning_tokens if usage else 0,
            done=not round_tool_calls,
        )

        # Track empty-response rounds for the degraded ladder (B2): a round that
        # produced no content AND no tool call is a degradation, not a finish.
        round_empty = not round_content and not round_tool_calls
        controller.note_empty_round(round_empty)

        if not round_tool_calls:
            if round_content:
                # A real textual answer with no further tool calls → normal finish.
                return final_content, final_reasoning, total_usage, round_idx + 1
            # Empty response: retry once on the fallback model, else end the turn
            # degraded rather than returning a blank reply.
            fallback_model = profile.fallback_model
            fallback_available = (
                settings.engine_fallback_enabled
                and fallback_model is not None
                and fallback_model != (active_model or profile.model)
            )
            action = controller.empty_response_action(
                fallback_available=fallback_available
            )
            if action is Intervention.FALLBACK:
                active_model = fallback_model
                logger.warning(
                    "engine.fallback_model", round=round_idx, fallback_model=fallback_model
                )
                continue
            if action is Intervention.FINALIZE:
                logger.warning("engine.degraded", round=round_idx)
                if finish_override_sink is not None:
                    finish_override_sink.append(FinishReason.DEGRADED)
                return final_content, final_reasoning, total_usage, round_idx + 1
            # CONTINUE (no fallback available): retry the round as-is.
            continue

        # DeepSeek thinking mode requires reasoning_content to be echoed back on
        # any assistant turn that carried tool_calls, or the next request 400s
        # (DeepSeek-V4-API参考.md §4.3 / llm.mdc 工具调用坑).
        assistant_msg = LLMMessage(
            role="assistant",
            content=round_content or None,
            tool_calls=round_tool_calls,
            reasoning_content=round_reasoning or None,
        )
        messages.append(assistant_msg)

        tool_results, terminal, attempts = await _execute_tools(
            round_tool_calls,
            tools,
            tool_context,
            sink,
            approval_gate=approval_gate,
            citation_sink=citation_sink,
            annotate_citations=annotate_citations,
            run_id=run_id,
        )
        messages.extend(tool_results)

        # A terminal-effect tool (handoff / ask_user-stop) already produced the
        # turn's final answer itself. Stop here so the model does not produce a
        # second reply; surface that answer (prefixed by any pre-tool content) for
        # persistence and fold the delegated run's token usage into the totals.
        if terminal is not None:
            usage_meta = terminal.metadata or {}
            total_usage = total_usage + TokenUsage(
                input_tokens=usage_meta.get("input_tokens", 0),
                output_tokens=usage_meta.get("output_tokens", 0),
                reasoning_tokens=usage_meta.get("reasoning_tokens", 0),
                cache_hit_tokens=usage_meta.get("cache_hit_tokens", 0),
                cache_miss_tokens=usage_meta.get("cache_miss_tokens", 0),
            )
            handoff_content = terminal.final_text or ""
            combined = join_segments(final_content, handoff_content)
            return combined, final_reasoning, total_usage, round_idx + 1

        controller.record(attempts)

        # B2 no-output early stop: track whether this round was *unproductive* —
        # every tool call failed AND the model wrote nothing. A sustained streak of
        # these (caught by the backstop below the pattern ladder) means the run is
        # going nowhere even though no single mechanical pattern tripped.
        round_all_failed = bool(attempts) and all(not a.success for a in attempts)
        controller.note_round_productivity(
            had_tool_calls=bool(round_tool_calls),
            all_failed=round_all_failed,
            had_content=bool(round_content),
        )

        # B2 tool failure circuit breaker: a tool that keeps failing (cumulative,
        # args-agnostic — what fingerprint-keyed REPEATED_FAILURE misses) gets the
        # model told to stop retrying it, then is removed from the toolset for the
        # rest of the run. Runs before the pattern ladder so a wedged tool is retired
        # up front; the injected steer is part of the real window, so it's journaled.
        breaker = controller.tool_circuit_breaker()
        if breaker.disabled:
            disabled_tools.update(breaker.disabled)
            tool_defs = _resolve_tool_defs()
        breaker_message = breaker.message()
        if breaker_message is not None:
            logger.info(
                "engine.tool_circuit_breaker",
                warned=list(breaker.warned),
                disabled=list(breaker.disabled),
                round=round_idx,
            )
            messages.append(LLMMessage(role="user", content=breaker_message))
            record_turn_fact(
                NoteFact(
                    role="user",
                    content=breaker_message,
                    reason="circuit_breaker",
                    run_id=run_id,
                ).to_fact()
            )

        # Convergence governance: detect mechanical loops and intervene. NUDGE
        # injects a fact-anchored reflection and lets the model recover; a second
        # trip FINALIZEs (force a tool-free answer) so we never spin to the cap.
        signal = controller.detect()
        action = controller.decide(signal)
        if signal is not None and action is Intervention.NUDGE:
            logger.info(
                "engine.loop_nudge",
                reason=signal.reason.value,
                tool=signal.tool_name,
                count=signal.count,
                round=round_idx,
            )
            reflection = signal.reflection_message()
            messages.append(LLMMessage(role="user", content=reflection))
            # 执行级事件溯源 (§18.3): the injected NUDGE is part of the real LLM window
            # (the next round sees it), so the window fold needs it as a fact.
            record_turn_fact(
                NoteFact(
                    role="user", content=reflection, reason="nudge", run_id=run_id
                ).to_fact()
            )
            continue
        if signal is not None and action is Intervention.FINALIZE:
            logger.warning(
                "engine.loop_finalize",
                reason=signal.reason.value,
                tool=signal.tool_name,
                count=signal.count,
                round=round_idx,
            )
            return await _force_finalize(
                messages=messages,
                llm=llm,
                profile=profile,
                emit_content=emit_content,
                emit_reasoning=emit_reasoning,
                final_content=final_content,
                final_reasoning=final_reasoning,
                total_usage=total_usage,
                rounds=round_idx + 1,
                reason=signal.reason.value,
                run_id=run_id,
            )

        # B2 no-output early stop (backstop): no mechanical pattern tripped, but the
        # model has spent the unproductive threshold of consecutive rounds with every
        # tool failing and nothing written — bail to a forced tool-free answer rather
        # than burning the rest of the budget, and surface the turn as UNPRODUCTIVE.
        if controller.unproductive_early_stop():
            logger.warning(
                "engine.unproductive_stop", round=round_idx, attempts=len(attempts)
            )
            if finish_override_sink is not None:
                finish_override_sink.append(FinishReason.UNPRODUCTIVE)
            return await _force_finalize(
                messages=messages,
                llm=llm,
                profile=profile,
                emit_content=emit_content,
                emit_reasoning=emit_reasoning,
                final_content=final_content,
                final_reasoning=final_reasoning,
                total_usage=total_usage,
                rounds=round_idx + 1,
                reason="unproductive",
                run_id=run_id,
            )

        # B2 reflection injection: on a long run, inject a periodic progress-review
        # steer (proactive re-plan beat, not loop-triggered). Skip when a circuit-
        # breaker steer already landed this round so we don't stack two system prompts.
        if breaker_message is None and controller.reflection_due(round_idx):
            review = progress_review_prompt(round_idx + 1)
            logger.info("engine.reflection_inject", round=round_idx)
            messages.append(LLMMessage(role="user", content=review))
            # 执行级事件溯源 (§18.3): injected into the real window → journaled as a fact.
            record_turn_fact(
                NoteFact(
                    role="user", content=review, reason="reflection", run_id=run_id
                ).to_fact()
            )

    # Round budget exhausted while still tool-calling: force a tool-free answer
    # rather than returning the empty/partial content accumulated so far (which
    # would surface as a blank reply — a loop with no designed exit).
    logger.warning("engine.max_rounds_exhausted", rounds=profile.max_rounds)
    return await _force_finalize(
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


def _tool_calls_to_dicts(tool_calls: list[ToolCall] | None) -> list[dict[str, Any]]:
    """Serialize a round's tool calls for the ``llm_call`` fact (§18.3).

    The window fold rebuilds the assistant message from this, so it mirrors the
    OpenAI/transcript shape (``runs.serialize._tool_call_to_dict``) exactly — id +
    type + function(name, arguments) — keeping the facts module free of an
    ``llm.protocol`` import on the read side.
    """
    if not tool_calls:
        return []
    return [
        {
            "id": tc.id,
            "type": tc.type,
            "function": {
                "name": tc.function.name,
                "arguments": tc.function.arguments,
            },
        }
        for tc in tool_calls
    ]


def join_segments(acc: str, new: str) -> str:
    """Append a round's text to the turn content as a separate paragraph.

    Each ReAct round is a distinct thought, and the model often calls a tool — even a
    turn-pausing ``ask_user`` — between rounds. Concatenating raw made a pre-tool
    lead-in (e.g. one ending in "：") run straight into the post-resume continuation in
    the flattened ``content`` (DB / LLM history / search preview). Insert a blank line
    between non-empty segments so they read as paragraphs. The live stream still emits
    raw deltas and the inline ask_user card rides the journal, so neither the live view
    nor the card position is affected.
    """
    if not acc:
        return new
    if not new:
        return acc
    if acc[-1].isspace():
        return acc + new
    return f"{acc}\n\n{new}"


async def _force_finalize(
    *,
    messages: list[LLMMessage],
    llm: DeepSeekProvider,
    profile: ModelProfile,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    final_content: str,
    final_reasoning: str,
    total_usage: TokenUsage,
    rounds: int,
    reason: str,
    run_id: str = "",
) -> tuple[str, str, TokenUsage, int]:
    """Force one tool-free LLM round to guarantee a real textual answer.

    Disables tools (``tool_choice="none"``) so the model must produce text. Used
    when convergence governance trips a hard finalize and when the round budget
    is exhausted mid-tool-call. Best-effort: on failure it returns whatever
    content was already accumulated rather than raising.
    """
    messages.append(LLMMessage(role="user", content=_FINALIZE_INSTRUCTION))
    # 执行级事件溯源 (§18.3): the forced-finalize instruction is injected into the real
    # LLM window, so the window fold needs it as a fact (no-op outside a turn). Scoped to
    # the calling run so the captain window picks it up even mid-delegate (边界②).
    record_turn_fact(
        NoteFact(
            role="user",
            content=_FINALIZE_INSTRUCTION,
            reason="finalize",
            run_id=run_id,
        ).to_fact()
    )
    request = build_request(profile, messages, tools=None, tool_choice="none")
    try:
        content, reasoning, _tool_calls, usage = await _stream_llm_round(
            llm, request, emit_content, emit_reasoning
        )
    except Exception as e:
        logger.error("engine.force_finalize_failed", reason=reason, error=str(e))
        return final_content, final_reasoning, total_usage, rounds

    if usage:
        total_usage = total_usage + usage

    combined_content = join_segments(final_content, content)
    combined_reasoning = (
        f"{final_reasoning}{reasoning}" if final_reasoning else reasoning
    )
    return combined_content, combined_reasoning, total_usage, rounds


async def _stream_llm_round(
    llm: DeepSeekProvider,
    request: LLMRequest,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    on_tool_progress: Callable[[str, int], None] | None = None,
) -> tuple[str, str, list[ToolCall] | None, TokenUsage | None]:
    """Stream one LLM call. Returns (content, reasoning, tool_calls, usage)."""

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tc_accumulators: dict[int, dict] = {}
    # Last arg length per tool-call index we emitted progress for (throttling).
    tc_progress_at: dict[int, int] = {}
    usage: TokenUsage | None = None
    finish_reason: str | None = None
    start = time.monotonic()

    async for chunk in llm.stream(request):
        if chunk.delta_content:
            content_parts.append(chunk.delta_content)
            emit_content(chunk.delta_content)

        if chunk.delta_reasoning:
            reasoning_parts.append(chunk.delta_reasoning)
            emit_reasoning(chunk.delta_reasoning)

        if chunk.finish_reason:
            finish_reason = chunk.finish_reason

        if chunk.delta_tool_calls:
            for tc_delta in chunk.delta_tool_calls:
                idx = tc_delta.index
                if idx not in tc_accumulators:
                    tc_accumulators[idx] = {
                        "id": tc_delta.id or "",
                        "name": tc_delta.function_name or "",
                        "arguments": "",
                    }
                else:
                    if tc_delta.id:
                        tc_accumulators[idx]["id"] = tc_delta.id
                    if tc_delta.function_name:
                        tc_accumulators[idx]["name"] = tc_delta.function_name
                if tc_delta.arguments_delta:
                    tc_accumulators[idx]["arguments"] += tc_delta.arguments_delta
                # Surface the (throttled) argument-streaming progress so a worker
                # writing a long file isn't invisible until tool_use_start. Fires
                # once the tool name is known, then every +_TOOL_PROGRESS_STEP chars.
                if on_tool_progress is not None:
                    name = tc_accumulators[idx]["name"]
                    chars = len(tc_accumulators[idx]["arguments"])
                    last = tc_progress_at.get(idx)
                    if name and (
                        last is None or chars - last >= _TOOL_PROGRESS_STEP
                    ):
                        tc_progress_at[idx] = chars
                        on_tool_progress(name, chars)

        if chunk.usage:
            usage = chunk.usage

    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)

    tool_calls: list[ToolCall] | None = None
    if tc_accumulators:
        tool_calls = []
        for _idx in sorted(tc_accumulators):
            acc = tc_accumulators[_idx]
            tool_calls.append(
                ToolCall(
                    id=acc["id"],
                    function=ToolCallFunction(
                        name=acc["name"],
                        arguments=acc["arguments"],
                    ),
                )
            )

    # Per-call observability (chat + worker share this streaming path). latency is
    # the full stream duration; finish_reason falls back to tool_calls/stop when the
    # provider omits it on the usage chunk. Attributes via request.scenario + the
    # ambient worker contextvars (run_id/agent_id/depth).
    log_llm_call(
        scenario=request.scenario,
        model=request.model,
        usage=usage,
        finish_reason=finish_reason or ("tool_calls" if tool_calls else "stop"),
        latency_ms=int((time.monotonic() - start) * 1000),
        stream=True,
        messages=request.messages,
        content=content,
        reasoning=reasoning,
    )

    return content, reasoning, tool_calls, usage


async def _execute_tools(
    tool_calls: list[ToolCall],
    registry: ToolRegistry,
    context: ToolContext,
    sink: EventSink,
    *,
    approval_gate: ApprovalGate | None = None,
    citation_sink: list[dict[str, Any]] | None = None,
    annotate_citations: bool = True,
    run_id: str = "",
) -> tuple[list[LLMMessage], ToolResult | None, list[ToolAttempt]]:
    """Execute tool calls (parallel, capped).

    Returns ``(tool_messages, terminal, attempts)`` where ``terminal`` is the
    first terminal-effect ToolResult (a tool that already produced the turn's
    final answer — handoff / ask_user-stop) or ``None``, and ``attempts`` carries
    the per-call fingerprint + success used by convergence governance to detect
    mechanical loops.

    When ``citation_sink`` is provided, web sources surfaced by successful research
    tools are merged into it (arrival order, deduped, capped). With
    ``annotate_citations`` (CEO chat path) each source's assigned canonical number
    is also folded back into that tool message's model-facing output (A2); merge
    happens in deterministic call order, not completion order, so card numbering is
    reproducible. Workers pass ``annotate_citations=False`` — sources are collected
    but the worker text is left un-numbered (its local numbers would be re-ordered
    when merged into the turn card).
    """

    async def _run_one(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        name = tc.function.name
        fingerprint = fingerprint_tool_call(name, tc.function.arguments or "")
        try:
            args = json.loads(tc.function.arguments) if tc.function.arguments else {}
        except json.JSONDecodeError:
            args = {}

        sink.emit(tool_use_start(tc.id, name, args))
        logger.debug("tool.execute_start", tool=name)

        tool = registry.get_optional(name)
        if tool is None:
            error_msg = f"Tool '{name}' not found"
            sink.emit(tool_use_end(tc.id, name, success=False, output=error_msg))
            logger.info("tool.execute_end", tool=name, status="not_found", duration_ms=0)
            return (
                LLMMessage(role="tool", content=error_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )

        if (
            approval_gate is not None
            and tool.schema.approval is ToolApproval.GRANTABLE
        ):
            decision = await approval_gate.authorize(
                tool_name=name, tool_call_id=tc.id, arguments=args
            )
            if decision is ApprovalDecision.DENY:
                denial = (
                    f"工具 '{name}' 未获用户授权，该操作未执行。"
                    "不要重试它——请调整方案或询问如何继续。"
                )
                sink.emit(tool_use_end(tc.id, name, success=False, output=denial))
                logger.info("tool.execute_end", tool=name, status="denied", duration_ms=0)
                return (
                    LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                    None,
                    ToolAttempt(fingerprint, name, success=False),
                    [],
                )

        started = time.monotonic()
        timeout = resolve_tool_timeout(tool.schema)
        try:
            if timeout is None:
                result = await tool.execute(args, context)
            else:
                result = await asyncio.wait_for(tool.execute(args, context), timeout)
        except TimeoutError:
            # B1 backstop: the call blew its ceiling. wait_for has already cancelled
            # the tool coroutine (a cancel-safe tool releases its side effects in
            # turn — e.g. the sandbox kills its subprocess); surface a model-facing
            # error so the loop adapts instead of hanging, and count it as a failed
            # attempt so a tool that keeps timing out trips convergence governance.
            duration_ms = int((time.monotonic() - started) * 1000)
            timeout_msg = (
                f"工具 '{name}' 执行超过 {timeout:.0f}s 仍未完成，已中止。"
                "请改用更快的方式、缩小处理范围，或换一种方案，不要原样重试。"
            )
            sink.emit(tool_use_end(tc.id, name, success=False, output=timeout_msg))
            logger.warning(
                "tool.execute_end", tool=name, status="timeout", duration_ms=duration_ms
            )
            return (
                LLMMessage(role="tool", content=timeout_msg, tool_call_id=tc.id),
                None,
                ToolAttempt(fingerprint, name, success=False),
                [],
            )
        result.tool_call_id = tc.id

        if result.success:
            output = result.output
        else:
            # Surface BOTH the terse error summary AND any diagnostic output
            # (stdout/stderr for code_execute) so the model can self-correct
            # instead of debugging blind: many tools put the real reason in
            # ``output``, not the short ``error`` (e.g. code_execute's error is
            # just "退出码 N" while the traceback / "command not found" lives in
            # output). Either may be empty; join the non-empty parts.
            output = (
                "\n".join(
                    p
                    for p in ((result.error or "").strip(), (result.output or "").strip())
                    if p
                )
                or "Unknown error"
            )
        sink.emit(
            tool_use_end(
                tc.id, name, success=result.success, output=output, display=result.display
            )
        )
        logger.info(
            "tool.execute_end",
            tool=name,
            status="ok" if result.success else "error",
            duration_ms=int((time.monotonic() - started) * 1000),
        )

        citations = result.citations if (result.success and result.citations) else []
        message = LLMMessage(role="tool", content=output, tool_call_id=tc.id)
        return (
            message,
            (result if result.is_terminal else None),
            ToolAttempt(fingerprint, name, success=result.success),
            citations,
        )

    sem = asyncio.Semaphore(_MAX_PARALLEL_TOOLS)

    async def _bounded(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt, list[dict[str, Any]]]:
        async with sem:
            return await _run_one(tc)

    quads = await asyncio.gather(*[_bounded(tc) for tc in tool_calls])
    messages = [m for m, _, _, _ in quads]
    terminal = next((t for _, t, _, _ in quads if t is not None), None)
    attempts = [a for _, _, a, _ in quads]

    # Merge web sources into the sink in deterministic call order (not completion
    # order) so card numbering is reproducible. With annotate_citations (CEO chat
    # path) the assigned canonical number (= source-card index) is also folded into
    # each tool message's model-facing output so the model cites a number that
    # lines up with the card (A2). Workers collect-only (annotate_citations=False):
    # their sources still reach the turn card via the executor → DelegateTool →
    # pipeline, but the worker text stays un-numbered.
    if citation_sink is not None:
        for message, _terminal, _attempt, message_citations in quads:
            if not message_citations:
                continue
            numbers = merge_citations(citation_sink, message_citations)
            if annotate_citations:
                message.content = annotate_tool_citations(
                    message.content or "", message_citations, numbers
                )

    # 执行级事件溯源 (§18.3 / Phase 2 边界①): record each completed call's FINAL
    # model-facing result as a tool_call fact — captured HERE, after the citation
    # annotation above, so it is byte-for-byte what the next round's window carried (the
    # forwarded tool_use_end fires inside _run_one with the pre-annotation text). The
    # window fold reads tool results from these facts. ``tool_calls`` is positionally
    # aligned with ``quads`` (asyncio.gather preserves order), so zip pairs each result
    # to its issuing call. A suspended call never reaches here (it blocks in execute), so
    # no fact is recorded for it — the fold reads that absence as "result still pending".
    for tc, (message, _terminal, attempt, _citations) in zip(tool_calls, quads):
        record_turn_fact(
            ToolCallFact(
                run_id=run_id,
                tool_call_id=message.tool_call_id or tc.id,
                name=tc.function.name,
                arguments=tc.function.arguments or "",
                result=message.content or "",
                success=attempt.success,
            ).to_fact()
        )

    return messages, terminal, attempts
