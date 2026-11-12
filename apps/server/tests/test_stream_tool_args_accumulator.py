"""Streamed tool-call argument assembly — fragments must join without loss.

The hot path collects ``arguments_delta`` fragments per tool index. A large file
write / patch arrives as thousands of fragments, so assembling them must stay
linear and byte-exact (this is the O(n^2) ``str +=`` regression guard).
"""

from __future__ import annotations

import pytest

from agentcore.llm.provider.protocol import LLMChunk, LLMRequest, ToolCallDelta
from agentcore.runtime.engine.stream import stream_llm_round


class _ScriptedProvider:
    def __init__(self, chunks: list[LLMChunk]) -> None:
        self._chunks = chunks
        self._name = "scripted"

    async def stream(self, request: LLMRequest):
        for c in self._chunks:
            yield c


def _req() -> LLMRequest:
    return LLMRequest(messages=[], model="m", scenario="chat")


@pytest.mark.asyncio
async def test_long_tool_arguments_join_in_order():
    parts = [f'{{"k{i}":"v{i}",' for i in range(4000)]
    chunks = [
        LLMChunk(
            delta_tool_calls=[
                ToolCallDelta(index=0, id="call_1", function_name="write_file", arguments_delta="")
            ]
        )
    ]
    chunks += [
        LLMChunk(delta_tool_calls=[ToolCallDelta(index=0, arguments_delta=p)]) for p in parts
    ]
    chunks.append(LLMChunk(finish_reason="tool_calls"))

    result = await stream_llm_round(
        _ScriptedProvider(chunks), _req(), lambda _d: None, lambda _d: None
    )
    assert result.tool_calls is not None
    assert len(result.tool_calls) == 1
    assert result.tool_calls[0].function.arguments == "".join(parts)
    assert result.tool_calls[0].function.name == "write_file"


@pytest.mark.asyncio
async def test_tool_progress_reports_char_count_not_fragment_count():
    # Fragments straddle the TOOL_PROGRESS_STEP (64 chars) throttle: reported
    # values must be cumulative CHARACTER counts, never fragment counts.
    parts = ["a" * 70, "b" * 70, "c" * 70]
    chunks = [
        LLMChunk(
            delta_tool_calls=[
                ToolCallDelta(index=0, id="c", function_name="f", arguments_delta="")
            ]
        )
    ]
    chunks += [
        LLMChunk(delta_tool_calls=[ToolCallDelta(index=0, arguments_delta=p)]) for p in parts
    ]
    chunks.append(LLMChunk(finish_reason="tool_calls"))

    progress: list[int] = []
    result = await stream_llm_round(
        _ScriptedProvider(chunks),
        _req(),
        lambda _d: None,
        lambda _d: None,
        on_tool_progress=lambda _name, chars: progress.append(chars),
    )
    assert result.tool_calls[0].function.arguments == "".join(parts)
    assert progress == [0, 70, 140, 210]


@pytest.mark.asyncio
async def test_multiple_tool_calls_keep_separate_arguments():
    chunks = [
        LLMChunk(
            delta_tool_calls=[
                ToolCallDelta(index=0, id="a", function_name="fa", arguments_delta="A1")
            ]
        ),
        LLMChunk(
            delta_tool_calls=[
                ToolCallDelta(index=1, id="b", function_name="fb", arguments_delta="B1")
            ]
        ),
        LLMChunk(
            delta_tool_calls=[ToolCallDelta(index=0, arguments_delta="A2")]
        ),
        LLMChunk(
            delta_tool_calls=[ToolCallDelta(index=1, arguments_delta="B2")]
        ),
        LLMChunk(finish_reason="tool_calls"),
    ]
    result = await stream_llm_round(
        _ScriptedProvider(chunks), _req(), lambda _d: None, lambda _d: None
    )
    by_name = {tc.function.name: tc.function.arguments for tc in result.tool_calls or []}
    assert by_name == {"fa": "A1A2", "fb": "B1B2"}
