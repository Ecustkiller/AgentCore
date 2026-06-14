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
from collections.abc import Callable
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile, build_request, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import (
    LLMMessage,
    LLMRequest,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
)
from agentcore.runtime.approvals import ApprovalDecision, ApprovalGate
from agentcore.runtime.events import (
    EventSink,
    content_delta,
    error_event,
    reasoning_delta,
    run_output_delta,
    run_reasoning_delta,
    tool_use_end,
    tool_use_start,
)
from agentcore.runtime.loop_controller import (
    Intervention,
    LoopController,
    ToolAttempt,
    fingerprint_tool_call,
)
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.registry import ToolRegistry

logger = get_logger(__name__)

_MAX_PARALLEL_TOOLS = 5

# Upper bound on sources surfaced per turn — enough to back any answer without
# turning the card strip into a wall.
_CITATION_CAP = 24


def _citation_key(citation: dict[str, Any]) -> str:
    """Normalized dedup key for a citation (same page from search + read_url, or
    from several engines, collapses): drop ``#fragment`` and trailing ``/``."""
    return (citation.get("url") or "").split("#", 1)[0].rstrip("/")


def _merge_citations(sink: list[dict[str, Any]], new: list[dict[str, Any]]) -> None:
    """Append unseen citations to ``sink`` in arrival order, capped.

    De-dups by normalized URL against everything already collected this turn, so
    a page the agent both searched up and read through is cited once.
    """
    seen = {_citation_key(c) for c in sink}
    for c in new:
        key = _citation_key(c)
        if not key or key in seen:
            continue
        seen.add(key)
        sink.append(c)
        if len(sink) >= _CITATION_CAP:
            return

# Injected when convergence governance forces a tool-free answer (a stuck loop
# trips a hard finalize, or the round budget is exhausted mid-tool-call).
_FINALIZE_INSTRUCTION = (
    "[系统提示] 请停止使用任何工具，基于目前已掌握的全部信息，立即给出你最好的最终答案。"
)


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
    raise_on_error: bool = False,
    citation_sink: list[dict[str, Any]] | None = None,
    approval_gate: ApprovalGate | None = None,
    synthesis_run_id: str | None = None,
    synthesis_agent_id: str | None = None,
    begin_synthesis: Callable[[], None] | None = None,
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
    /``on_reasoning`` to redirect text into ``run_output_delta`` instead.
    ``allowed_tool_names`` filters which tools the model may call (``None`` = all,
    ``[]`` = none). Tool execution events always go to the sink. When
    ``citation_sink`` is provided, web sources consulted by research tools are
    aggregated into it (de-duped, capped) for the caller to surface/persist.
    ``approval_gate`` (CEO chat path only; ``None`` for delegated workers) pauses
    GRANTABLE tool calls until the user authorizes them — a denial is fed back to
    the model as a tool result so it can adapt.

    ``synthesis_run_id`` / ``synthesis_agent_id`` / ``begin_synthesis`` wire the
    CEO's 「汇总过程」(D3 / Phase B): when supplied (CEO chat path only) and the
    captain resumes after a non-terminal ORCHESTRATION tool (``delegate``)
    returns, the loop flips into synthesis mode for the remaining rounds —
    ``begin_synthesis`` is invoked once (the caller declares + starts the
    synthesis run), that phase's reasoning streams run-scoped as the synthesis
    node's 思考过程 (and is NOT folded into the chat bubble's thinking), and its
    content streams to the chat bubble AND mirrors to the node's output. Absent
    (workers / non-delegating turns) the loop behaves exactly as before.
    """
    profile = profile or get_profile("chat")

    if allowed_tool_names is None:
        tool_defs = tools.get_openai_definitions() if tools.count > 0 else None
    elif allowed_tool_names:
        tool_defs = tools.get_openai_definitions(allowed_tool_names) or None
    else:
        tool_defs = None

    emit_content = on_content or (lambda delta: sink.emit(content_delta(delta)))
    emit_reasoning = on_reasoning or (lambda delta: sink.emit(reasoning_delta(delta)))

    # CEO synthesis phase (D3 / Phase B). Once the captain resumes after a
    # non-terminal orchestration tool returns, the integration round's reasoning
    # is the team's 「汇总过程」 — streamed run-scoped to the synthesis node — and
    # its content is the user-facing overview, which still streams to the chat
    # bubble AND mirrors to the node's output. Gated on a synthesis_run_id being
    # supplied (CEO pipeline only); zero-overhead and inert for workers.
    synthesis_enabled = (
        synthesis_run_id is not None and synthesis_agent_id is not None
    )
    synthesizing = False

    def _synth_content(delta: str) -> None:
        emit_content(delta)
        sink.emit(run_output_delta(synthesis_run_id, synthesis_agent_id, delta))

    def _synth_reasoning(delta: str) -> None:
        sink.emit(run_reasoning_delta(synthesis_run_id, synthesis_agent_id, delta))

    total_usage = TokenUsage()
    final_content = ""
    final_reasoning = ""

    # Per-run convergence governance: detects mechanical loops outside the model.
    controller = LoopController()

    for round_idx in range(profile.max_rounds):
        # Once in synthesis mode, this round's reasoning/content stream to the
        # synthesis node; otherwise they take the normal chat/worker path.
        round_emit_content = _synth_content if synthesizing else emit_content
        round_emit_reasoning = _synth_reasoning if synthesizing else emit_reasoning

        request = build_request(
            profile,
            messages,
            tools=tool_defs,
            tool_choice="auto" if tool_defs else "none",
        )

        try:
            round_content, round_reasoning, round_tool_calls, usage = (
                await _stream_llm_round(llm, request, round_emit_content, round_emit_reasoning)
            )
        except Exception as e:
            logger.error("llm_call_failed", round=round_idx, error=str(e))
            if raise_on_error:
                raise
            sink.emit(error_event("LLM_ERROR", str(e)))
            return final_content, final_reasoning, total_usage, round_idx + 1

        if usage:
            total_usage = total_usage + usage

        if round_content:
            final_content += round_content

        if round_reasoning and not synthesizing:
            # Synthesis-phase reasoning is the team's 「汇总过程」, journaled
            # run-scoped to the synthesis node (run_reasoning_delta) rather than
            # folded into the chat bubble's thinking — so the two stay distinct.
            final_reasoning += round_reasoning

        if not round_tool_calls:
            return final_content, final_reasoning, total_usage, round_idx + 1

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

        tool_results, terminal, attempts, round_citations = await _execute_tools(
            round_tool_calls, tools, tool_context, sink, approval_gate=approval_gate
        )
        messages.extend(tool_results)

        if citation_sink is not None and round_citations:
            _merge_citations(citation_sink, round_citations)

        # CEO synthesis boundary (D3 / Phase B): the captain just got a
        # non-terminal ORCHESTRATION tool's results (delegate) back — the next
        # round integrates them into the user-facing answer. Flip into synthesis
        # mode so that round streams to the synthesis node; begin_synthesis
        # (caller-provided) declares + starts the synthesis run exactly once.
        if (
            synthesis_enabled
            and not synthesizing
            and begin_synthesis is not None
            and any(
                (tool := tools.get_optional(tc.function.name)) is not None
                and tool.schema.category is ToolCategory.ORCHESTRATION
                for tc in round_tool_calls
            )
        ):
            begin_synthesis()
            synthesizing = True

        # A handoff tool (a terminal tool) already streamed the turn's final
        # answer itself. Stop here so the model does not produce a second reply;
        # surface the streamed answer (prefixed by any pre-tool content) for
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
            handoff_content = terminal.terminal_content or ""
            combined = (
                f"{final_content}{handoff_content}" if final_content else handoff_content
            )
            return combined, final_reasoning, total_usage, round_idx + 1

        # Convergence governance: detect mechanical loops and intervene. NUDGE
        # injects a fact-anchored reflection and lets the model recover; a second
        # trip FINALIZEs (force a tool-free answer) so we never spin to the cap.
        controller.record(attempts)
        signal = controller.detect()
        action = controller.decide(signal)
        if signal is not None and action is Intervention.NUDGE:
            logger.info(
                "loop_nudge",
                reason=signal.reason.value,
                tool=signal.tool_name,
                count=signal.count,
                round=round_idx,
            )
            messages.append(LLMMessage(role="user", content=signal.reflection_message()))
            continue
        if signal is not None and action is Intervention.FINALIZE:
            logger.warning(
                "loop_finalize",
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
            )

    # Round budget exhausted while still tool-calling: force a tool-free answer
    # rather than returning the empty/partial content accumulated so far (which
    # would surface as a blank reply — a loop with no designed exit).
    logger.warning("max_rounds_exhausted", rounds=profile.max_rounds)
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
    )


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
) -> tuple[str, str, TokenUsage, int]:
    """Force one tool-free LLM round to guarantee a real textual answer.

    Disables tools (``tool_choice="none"``) so the model must produce text. Used
    when convergence governance trips a hard finalize and when the round budget
    is exhausted mid-tool-call. Best-effort: on failure it returns whatever
    content was already accumulated rather than raising.
    """
    messages.append(LLMMessage(role="user", content=_FINALIZE_INSTRUCTION))
    request = build_request(profile, messages, tools=None, tool_choice="none")
    try:
        content, reasoning, _tool_calls, usage = await _stream_llm_round(
            llm, request, emit_content, emit_reasoning
        )
    except Exception as e:
        logger.error("force_finalize_failed", reason=reason, error=str(e))
        return final_content, final_reasoning, total_usage, rounds

    if usage:
        total_usage = total_usage + usage

    combined_content = f"{final_content}{content}" if final_content else content
    combined_reasoning = (
        f"{final_reasoning}{reasoning}" if final_reasoning else reasoning
    )
    return combined_content, combined_reasoning, total_usage, rounds


async def _stream_llm_round(
    llm: DeepSeekProvider,
    request: LLMRequest,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
) -> tuple[str, str, list[ToolCall] | None, TokenUsage | None]:
    """Stream one LLM call. Returns (content, reasoning, tool_calls, usage)."""

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tc_accumulators: dict[int, dict] = {}
    usage: TokenUsage | None = None

    async for chunk in llm.stream(request):
        if chunk.delta_content:
            content_parts.append(chunk.delta_content)
            emit_content(chunk.delta_content)

        if chunk.delta_reasoning:
            reasoning_parts.append(chunk.delta_reasoning)
            emit_reasoning(chunk.delta_reasoning)

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

    return content, reasoning, tool_calls, usage


async def _execute_tools(
    tool_calls: list[ToolCall],
    registry: ToolRegistry,
    context: ToolContext,
    sink: EventSink,
    *,
    approval_gate: ApprovalGate | None = None,
) -> tuple[list[LLMMessage], ToolResult | None, list[ToolAttempt], list[dict[str, Any]]]:
    """Execute tool calls (parallel, capped).

    Returns ``(tool_messages, terminal, attempts, citations)`` where ``terminal``
    is the first handoff ToolResult (a tool that already produced the turn's final
    answer) or ``None``, ``attempts`` carries the per-call fingerprint + success
    used by convergence governance to detect mechanical loops, and ``citations``
    are the web sources surfaced by successful research tools this round (in call
    order; de-dup happens upstream across the whole turn).
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

        tool = registry.get_optional(name)
        if tool is None:
            error_msg = f"Tool '{name}' not found"
            sink.emit(tool_use_end(tc.id, name, success=False, output=error_msg))
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
                    f"Tool '{name}' was not authorized by the user; the action was "
                    "not performed. Do not retry it — adapt or ask how to proceed."
                )
                sink.emit(tool_use_end(tc.id, name, success=False, output=denial))
                return (
                    LLMMessage(role="tool", content=denial, tool_call_id=tc.id),
                    None,
                    ToolAttempt(fingerprint, name, success=False),
                    [],
                )

        result = await tool.execute(args, context)
        result.tool_call_id = tc.id

        output = result.output if result.success else (result.error or "Unknown error")
        sink.emit(tool_use_end(tc.id, name, success=result.success, output=output))

        citations = result.citations if (result.success and result.citations) else []
        message = LLMMessage(role="tool", content=output, tool_call_id=tc.id)
        return (
            message,
            (result if result.terminal else None),
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
    citations = [c for _, _, _, cs in quads for c in cs]
    return messages, terminal, attempts, citations
