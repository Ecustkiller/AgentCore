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

from agentcore.core.logging import get_logger
from agentcore.llm.config import ModelProfile, build_request, get_profile
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import (
    LLMMessage,
    LLMRequest,
    TokenUsage,
    ToolCall,
    ToolCallFunction,
)
from agentcore.runtime.events import (
    EventSink,
    content_delta,
    error_event,
    reasoning_delta,
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
) -> tuple[str, str, int, int, int, int]:
    """Run the ReAct loop.

    Returns
    (final_content, final_reasoning, input_tokens, output_tokens,
    reasoning_tokens, rounds). ``final_reasoning`` is the concatenated thinking
    text across all rounds (empty when thinking is disabled), mirroring what was
    streamed via ``reasoning_delta`` so it can be persisted for replay.

    The ``profile`` drives both the model params and the round budget
    (``profile.max_rounds``); it defaults to the chat profile. By
    default content/reasoning deltas are emitted as conversation events
    (single-agent path). A caller running a multi-agent run passes ``on_content``
    /``on_reasoning`` to redirect text into ``run_output_delta`` instead.
    ``allowed_tool_names`` filters which tools the model may call (``None`` = all,
    ``[]`` = none). Tool execution events always go to the sink.
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

    total_input = 0
    total_output = 0
    total_reasoning = 0
    final_content = ""
    final_reasoning = ""

    # Per-run convergence governance: detects mechanical loops outside the model.
    controller = LoopController()

    for round_idx in range(profile.max_rounds):
        request = build_request(
            profile,
            messages,
            tools=tool_defs,
            tool_choice="auto" if tool_defs else "none",
        )

        try:
            round_content, round_reasoning, round_tool_calls, usage = (
                await _stream_llm_round(llm, request, emit_content, emit_reasoning)
            )
        except Exception as e:
            logger.error("llm_call_failed", round=round_idx, error=str(e))
            if raise_on_error:
                raise
            sink.emit(error_event("LLM_ERROR", str(e)))
            return (
                final_content,
                final_reasoning,
                total_input,
                total_output,
                total_reasoning,
                round_idx + 1,
            )

        if usage:
            total_input += usage.input_tokens
            total_output += usage.output_tokens
            total_reasoning += usage.reasoning_tokens

        if round_content:
            final_content += round_content

        if round_reasoning:
            final_reasoning += round_reasoning

        if not round_tool_calls:
            return (
                final_content,
                final_reasoning,
                total_input,
                total_output,
                total_reasoning,
                round_idx + 1,
            )

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
            round_tool_calls, tools, tool_context, sink
        )
        messages.extend(tool_results)

        # A handoff tool (e.g. assemble_team) already streamed the turn's final
        # answer itself. Stop here so the model does not produce a second reply;
        # surface the streamed answer (prefixed by any pre-tool content) for
        # persistence and fold the delegated run's token usage into the totals.
        if terminal is not None:
            usage_meta = terminal.metadata or {}
            total_input += usage_meta.get("input_tokens", 0)
            total_output += usage_meta.get("output_tokens", 0)
            total_reasoning += usage_meta.get("reasoning_tokens", 0)
            handoff_content = terminal.terminal_content or ""
            combined = (
                f"{final_content}{handoff_content}" if final_content else handoff_content
            )
            return (
                combined,
                final_reasoning,
                total_input,
                total_output,
                total_reasoning,
                round_idx + 1,
            )

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
                total_input=total_input,
                total_output=total_output,
                total_reasoning=total_reasoning,
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
        total_input=total_input,
        total_output=total_output,
        total_reasoning=total_reasoning,
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
    total_input: int,
    total_output: int,
    total_reasoning: int,
    rounds: int,
    reason: str,
) -> tuple[str, str, int, int, int, int]:
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
        return (
            final_content,
            final_reasoning,
            total_input,
            total_output,
            total_reasoning,
            rounds,
        )

    if usage:
        total_input += usage.input_tokens
        total_output += usage.output_tokens
        total_reasoning += usage.reasoning_tokens

    combined_content = f"{final_content}{content}" if final_content else content
    combined_reasoning = (
        f"{final_reasoning}{reasoning}" if final_reasoning else reasoning
    )
    return (
        combined_content,
        combined_reasoning,
        total_input,
        total_output,
        total_reasoning,
        rounds,
    )


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
) -> tuple[list[LLMMessage], ToolResult | None, list[ToolAttempt]]:
    """Execute tool calls (parallel, capped).

    Returns ``(tool_messages, terminal, attempts)`` where ``terminal`` is the
    first handoff ToolResult (a tool that already produced the turn's final
    answer) or ``None``, and ``attempts`` carries the per-call fingerprint +
    success used by convergence governance to detect mechanical loops.
    """

    async def _run_one(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt]:
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
            )

        result = await tool.execute(args, context)
        result.tool_call_id = tc.id

        output = result.output if result.success else (result.error or "Unknown error")
        sink.emit(tool_use_end(tc.id, name, success=result.success, output=output))

        message = LLMMessage(role="tool", content=output, tool_call_id=tc.id)
        return (
            message,
            (result if result.terminal else None),
            ToolAttempt(fingerprint, name, success=result.success),
        )

    sem = asyncio.Semaphore(_MAX_PARALLEL_TOOLS)

    async def _bounded(
        tc: ToolCall,
    ) -> tuple[LLMMessage, ToolResult | None, ToolAttempt]:
        async with sem:
            return await _run_one(tc)

    triples = await asyncio.gather(*[_bounded(tc) for tc in tool_calls])
    messages = [m for m, _, _ in triples]
    terminal = next((t for _, t, _ in triples if t is not None), None)
    attempts = [a for _, _, a in triples]
    return messages, terminal, attempts
