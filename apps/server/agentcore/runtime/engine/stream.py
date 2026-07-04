"""One-round LLM streaming for the ReAct loop."""

import asyncio
import time
from collections.abc import Callable

from agentcore.config import settings
from agentcore.core.errors import LLMTimeoutError
from agentcore.core.logging import get_logger
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.observability import log_llm_call
from agentcore.llm.protocol import LLMRequest, TokenUsage, ToolCall, ToolCallFunction

from .constants import TOOL_PROGRESS_STEP

logger = get_logger(__name__)


async def stream_llm_round(
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

    # 流式停滞闸 (卡死根因): consume the stream under a per-chunk IDLE ceiling. The
    # deadline is reset on EVERY chunk, so a healthy long generation (which keeps
    # streaming reasoning/content) never trips it, but a genuine stall (no bytes for
    # ``idle`` seconds) raises promptly and observably — instead of the provider's
    # silent 120s×3 read-timeout ladder freezing the whole turn for ~6 min. ``0``
    # disables the gate (``asyncio.timeout(None)`` = no ceiling). On a stall the
    # ``async for`` cancellation unwinds llm.stream's ``async with client.stream(...)``,
    # closing the httpx connection; we re-raise as an LLM timeout so run_llm_round's
    # failure ladder (fallback model → clean DEGRADED/ERROR end) takes over.
    idle = settings.engine_llm_stream_idle_timeout_seconds
    loop = asyncio.get_running_loop()
    try:
        async with asyncio.timeout(idle if idle > 0 else None) as cm:
            async for chunk in llm.stream(request):
                if idle > 0:
                    cm.reschedule(loop.time() + idle)

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
                        # once the tool name is known, then every +TOOL_PROGRESS_STEP chars.
                        if on_tool_progress is not None:
                            name = tc_accumulators[idx]["name"]
                            chars = len(tc_accumulators[idx]["arguments"])
                            last = tc_progress_at.get(idx)
                            if name and (last is None or chars - last >= TOOL_PROGRESS_STEP):
                                tc_progress_at[idx] = chars
                                on_tool_progress(name, chars)

                if chunk.usage:
                    usage = chunk.usage
    except TimeoutError:
        logger.warning(
            "llm.stream_stalled",
            scenario=request.scenario,
            model=request.model,
            idle_seconds=idle,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            content_chars=sum(len(p) for p in content_parts),
            reasoning_chars=sum(len(p) for p in reasoning_parts),
        )
        raise LLMTimeoutError("模型流式响应停滞（长时间无输出），请稍后重试") from None

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
