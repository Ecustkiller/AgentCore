"""ReAct main loop: turn control, LLM rounds, tool execution, governance."""

from collections.abc import Callable
from typing import Any

from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile, build_request, get_profile
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
from agentcore.runtime.facts import (
    LlmCallFact,
    NoteFact,
    RoundBoundaryFact,
    record_turn_fact,
)
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    delegation_nudge_prompt,
    progress_review_prompt,
)
from agentcore.runtime.verify import finish_guard, format_guard_steer
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry

from .finalize import force_finalize
from .segments import join_segments, tool_calls_to_dicts
from .stream import stream_llm_round
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

    # Manager-CEO breadth nudge (档2.5): classify this run's available tools so the
    # controller can tell when a delegation-capable run (CEO captain / can_delegate
    # worker) keeps investigating solo and should fan the breadth out to a research
    # team. Investigation = read-only info-gathering (NEVER-approval FILESYSTEM /
    # SEARCH / RESEARCH); delegation = ORCHESTRATION (delegate / revise). A leaf
    # worker has no ORCHESTRATION tool → empty delegation set → the controller's own
    # guard keeps the nudge dormant, so workers are never told to delegate work they own.
    available_names = (
        set(allowed_tool_names) if allowed_tool_names is not None else set(tools.names)
    )
    schema_by_name = {schema.name: schema for schema in tools.list_all()}
    investigation_tools: set[str] = set()
    delegation_tools: set[str] = set()
    for name in available_names:
        schema = schema_by_name.get(name)
        if schema is None:
            continue
        if schema.category is ToolCategory.ORCHESTRATION:
            delegation_tools.add(name)
        elif schema.approval is ToolApproval.NEVER and schema.category in (
            ToolCategory.FILESYSTEM,
            ToolCategory.SEARCH,
            ToolCategory.RESEARCH,
        ):
            investigation_tools.add(name)

    # Per-run convergence governance: detects mechanical loops outside the model.
    controller = LoopController(
        empty_threshold=settings.engine_empty_response_threshold,
        tool_failure_warn=settings.engine_tool_failure_warn,
        tool_failure_disable=settings.engine_tool_failure_disable,
        unproductive_threshold=settings.engine_unproductive_threshold,
        reflection_start_round=settings.engine_reflection_start_round,
        reflection_interval=settings.engine_reflection_interval,
        delegation_nudge_threshold=settings.engine_delegation_nudge_threshold,
        investigation_tools=frozenset(investigation_tools),
        delegation_tools=frozenset(delegation_tools),
    )
    # B2 degraded fallback: the model the next round runs on. None = the profile's
    # own model; set to profile.fallback_model after an empty round to retry once on
    # the stronger model. Sticky for the rest of the run once escalated.
    active_model: str | None = None

    # 交付前核验回炉计数（finish_guard）：CEO 自报 done 时若轻层未过则回炉重写；此计数限制
    # 同一 run 被这样退回的次数（计入 max_rounds 总预算），超上限即按现状放行、留待 pipeline
    # 的 out_of_range warning 记录残留。
    finish_guard_reworks = 0

    for round_idx in range(profile.max_rounds):
        logger.debug("react.round_start", round=round_idx, messages=len(messages))
        # 执行级事件溯源 (§18.3): mark this ReAct round edge — the seam `round_boundary.
        # fold` later cuts the LLM window / pause snapshot on. No-op outside a turn.
        record_turn_fact(
            RoundBoundaryFact(round_idx=round_idx, run_id=run_id, role=role).to_fact()
        )
        # 交付前核验回炉用（finish_guard）：记下本轮 LLM 输出累加前的正文；若本轮自报 done 但
        # 轻层未过需回炉，把 final_content 退回这里（丢掉这一版待修正的正文），让模型下一轮重写
        # 完整答案，而非续接在违规版后面。
        content_before_round = final_content
        request = build_request(
            profile,
            messages,
            tools=tool_defs,
            tool_choice="auto" if tool_defs else "none",
            model=active_model,
        )

        try:
            round_content, round_reasoning, round_tool_calls, usage = (
                await stream_llm_round(
                    llm, request, emit_content, emit_reasoning, on_tool_progress
                )
            )
        except Exception as e:
            logger.error("llm.call_failed", round=round_idx, error=str(e))
            if raise_on_error:
                raise
            # Preserve an AgentCoreError's curated zh message + specific code (e.g.
            # LLM_INSUFFICIENT_BALANCE) so the client can act on it; collapse any other
            # (raw technical) exception to a generic friendly line instead of leaking
            # it into the chat. error_fields_for = the shared coded-vs-opaque classifier.
            code, message = error_fields_for(
                e,
                fallback_code=ErrorCode.LLM_ERROR,
                fallback_message="出了点问题，请稍后重试。",
            )
            sink.emit(error_event(code, message))
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
                tool_calls=tool_calls_to_dicts(round_tool_calls),
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
                # 交付前核验·轻层守卫 (finish_guard): 自报 done（无工具调用 + 有正文）时不立刻
                # 接受，先过纯代码轻层。命中且回炉额度未尽 → 丢弃这一版（content_reset 清空已
                # 流式到气泡的正文）、把 final_content 退回本轮之前、注入锚定事实的修正提示、不
                # 算 done、继续循环——ReAct「唯一终止信号 = done」的对称解，CEO 直答与 worker
                # 收尾同处覆盖。仅 CEO 路径（annotate_citations）跑校验：worker 文本未编号、其
                # 本地 [n] 汇入回合卡会重排，此校验语义不适用。
                reworks = (
                    finish_guard(final_content, citation_count=len(citation_sink or []))
                    if annotate_citations
                    else []
                )
                if (
                    reworks
                    and finish_guard_reworks < settings.engine_finish_guard_max_reworks
                ):
                    finish_guard_reworks += 1
                    steer = format_guard_steer(reworks)
                    logger.info(
                        "engine.finish_guard_rework",
                        round=round_idx,
                        attempt=finish_guard_reworks,
                        issues=len(reworks),
                    )
                    sink.emit(content_reset())
                    final_content = content_before_round
                    messages.append(LLMMessage(role="user", content=steer))
                    # 注入的修正提示是真实 LLM 窗口的一部分（下一轮可见），故窗口 fold 需要它
                    # 作为 fact（无 turn 时 no-op）。
                    record_turn_fact(
                        NoteFact(
                            role="user",
                            content=steer,
                            reason="finish_guard",
                            run_id=run_id,
                        ).to_fact()
                    )
                    continue
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

        tool_results, terminal, attempts = await execute_tools(
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
                reason="unproductive",
                run_id=run_id,
            )

        # Manager-CEO breadth nudge (档2.5 纯粹管理者 CEO): a delegation-capable run that
        # keeps doing read-only investigation itself (breadth crossing the threshold, no
        # delegate yet) gets ONE steer to fan the investigation out to a parallel research
        # team — broad investigation is the team's job even when the final answer is
        # conversational. Gated on round so a legitimate opening scout batch (pre-delegation
        # 探路) doesn't trip it, and skipped when a circuit-breaker steer already landed so
        # we never stack two system prompts in one round. Injected into the real window →
        # journaled as a fact like the other steers.
        delegation_nudged = (
            breaker_message is None
            and round_idx >= settings.engine_delegation_nudge_min_round
            and controller.delegation_nudge_due()
        )
        if delegation_nudged:
            steer = delegation_nudge_prompt(controller.investigation_calls)
            logger.info(
                "engine.delegation_nudge",
                round=round_idx,
                investigation_calls=controller.investigation_calls,
            )
            messages.append(LLMMessage(role="user", content=steer))
            record_turn_fact(
                NoteFact(
                    role="user", content=steer, reason="delegation_nudge", run_id=run_id
                ).to_fact()
            )

        # B2 reflection injection: on a long run, inject a periodic progress-review
        # steer (proactive re-plan beat, not loop-triggered). Skip when a circuit-
        # breaker or delegation-breadth steer already landed this round so we don't
        # stack two system prompts.
        if (
            breaker_message is None
            and not delegation_nudged
            and controller.reflection_due(round_idx)
        ):
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
