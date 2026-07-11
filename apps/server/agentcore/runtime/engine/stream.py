"""One-round LLM streaming for the ReAct loop."""

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass

from agentcore.config import settings
from agentcore.core.errors import LLMTimeoutError
from agentcore.core.logging import get_logger
from agentcore.llm.observability import log_llm_call
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMRequest, TokenUsage, ToolCall, ToolCallFunction

from .constants import TOOL_PROGRESS_STEP

logger = get_logger(__name__)


@dataclass(frozen=True)
class StreamRoundResult:
    """Outcome of one streamed LLM call (including post-commit abort salvage)."""

    content: str
    reasoning: str
    tool_calls: list[ToolCall] | None
    usage: TokenUsage | None
    empty_diagnosis: str | None = None
    empty_raw_preview: str | None = None
    aborted: bool = False


async def stream_llm_round(
    llm: OpenAICompatibleProvider,
    request: LLMRequest,
    emit_content: Callable[[str], None],
    emit_reasoning: Callable[[str], None],
    on_tool_progress: Callable[[str, int], None] | None = None,
    on_reset: Callable[[], None] | None = None,
) -> StreamRoundResult:
    """Stream one LLM call. Returns accumulated text plus an optional aborted flag.

    Consumes provider control signals:
    - ``stream_reset`` — clear local accumulators and reset the live view (CEO
      ``content_reset`` / worker ``run_output_reset`` via ``on_reset``).
    - ``aborted`` — keep the partial and return normally (no raise).
    """

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    tc_accumulators: dict[int, dict] = {}
    # Last arg length per tool-call index we emitted progress for (throttling).
    tc_progress_at: dict[int, int] = {}
    usage: TokenUsage | None = None
    finish_reason: str | None = None
    empty_diagnosis: str | None = None
    empty_raw_preview: str | None = None
    aborted = False
    start = time.monotonic()

    def _clear_accumulators() -> None:
        content_parts.clear()
        reasoning_parts.clear()
        tc_accumulators.clear()
        tc_progress_at.clear()

    # 流式停滞闸 (卡死根因): consume the stream under a per-chunk IDLE ceiling. The
    # deadline is reset on EVERY chunk, so a healthy long generation (which keeps
    # streaming reasoning/content) never trips it, but a genuine stall (no bytes for
    # ``idle`` seconds) raises promptly and observably — instead of the provider's
    # silent 120s×3 read-timeout ladder freezing the whole turn for ~6 min. ``0``
    # disables the gate (``asyncio.timeout(None)`` = no ceiling). Post-commit stall
    # salvages the partial via the same aborted contract as a mid-stream disconnect;
    # pre-commit stall still surfaces as LLMTimeoutError.
    idle = settings.engine_llm_stream_idle_timeout_seconds
    loop = asyncio.get_running_loop()
    try:
        async with asyncio.timeout(idle if idle > 0 else None) as cm:
            async for chunk in llm.stream(request):
                if idle > 0:
                    cm.reschedule(loop.time() + idle)

                if chunk.stream_reset:
                    _clear_accumulators()
                    usage = None
                    finish_reason = None
                    empty_diagnosis = None
                    empty_raw_preview = None
                    if on_reset is not None:
                        on_reset()
                    continue

                if chunk.aborted:
                    aborted = True
                    break

                if chunk.empty_diagnosis:
                    empty_diagnosis = chunk.empty_diagnosis
                if chunk.empty_raw_preview:
                    empty_raw_preview = chunk.empty_raw_preview

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
        committed = bool(content_parts) or bool(tc_accumulators)
        logger.warning(
            "llm.stream_stalled",
            scenario=request.scenario,
            model=request.model,
            idle_seconds=idle,
            elapsed_ms=int((time.monotonic() - start) * 1000),
            content_chars=sum(len(p) for p in content_parts),
            reasoning_chars=sum(len(p) for p in reasoning_parts),
            committed=committed,
        )
        if committed:
            aborted = True
        else:
            raise LLMTimeoutError("模型流式响应停滞（长时间无输出），请稍后重试") from None

    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)

    # Incomplete tool-call deltas after abort are not executable — drop them so the
    # engine keeps prose only (设计: 保留半成品正文, 不执行残缺 tool_calls).
    tool_calls: list[ToolCall] | None = None
    if tc_accumulators and not aborted:
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
        finish_reason=finish_reason
        or ("tool_calls" if tool_calls else ("aborted" if aborted else "stop")),
        latency_ms=int((time.monotonic() - start) * 1000),
        stream=True,
        messages=request.messages,
        content=content,
        reasoning=reasoning,
        tool_names=[tc.function.name for tc in tool_calls] if tool_calls else None,
    )

    return StreamRoundResult(
        content=content,
        reasoning=reasoning,
        tool_calls=tool_calls,
        usage=usage,
        empty_diagnosis=empty_diagnosis,
        empty_raw_preview=empty_raw_preview,
        aborted=aborted,
    )
