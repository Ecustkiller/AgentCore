"""Unit tests for forced-finalize coordination-tool filtering."""

import pytest

from agentcore.core.types import ToolCategory
from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.engine.constants import FINALIZE_COORDINATION_TOOLS
from agentcore.runtime.engine.finalize import force_finalize, run_finalize_round
from agentcore.runtime.engine.governance import resolve_finalize_coordination_tools
from agentcore.tools.protocol import ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from tests.llm_helpers import make_profile_params


def _tool_chunk(name: str, args: str = "{}", *, call_id: str = "c1") -> LLMChunk:
    return LLMChunk(
        delta_tool_calls=[
            ToolCallDelta(index=0, id=call_id, function_name=name, arguments_delta=args)
        ]
    )


def _content_chunk(text: str) -> LLMChunk:
    return LLMChunk(delta_content=text)


class _ScriptedProvider:
    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0
        self.last_tool_choice: str | None = None
        self.last_tool_names: list[str] | None = None

    async def stream(self, request):  # noqa: ANN001
        self.last_tool_choice = request.tool_choice
        self.last_tool_names = [t["function"]["name"] for t in (request.tools or [])]
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _StubTool:
    def __init__(self, name: str, *, category: ToolCategory = ToolCategory.SEARCH) -> None:
        self._name = name
        self._category = category

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=self._category,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        return ToolResult(tool_call_id="", success=True, output="ok")


def _registry() -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(_StubTool("file_read", category=ToolCategory.FILESYSTEM))
    reg.register(_StubTool("delegate", category=ToolCategory.ORCHESTRATION))
    reg.register(_StubTool("consult_skill", category=ToolCategory.ORCHESTRATION))
    reg.register(_StubTool("ask_user", category=ToolCategory.INTERACTION))
    return reg


def test_resolve_finalize_coordination_tools_filters_to_allowlist():
    reg = _registry()
    defs = resolve_finalize_coordination_tools(reg, None, set())
    names = {d["function"]["name"] for d in (defs or [])}
    assert names == FINALIZE_COORDINATION_TOOLS
    assert "file_read" not in names


@pytest.mark.asyncio
async def test_soft_finalize_uses_coordination_tools_not_none():
    provider = _ScriptedProvider([[_content_chunk("收尾答案")]])
    messages = [LLMMessage(role="user", content="go")]
    reg = _registry()
    result = await run_finalize_round(
        messages=messages,
        llm=provider,
        profile=make_profile_params(),
        active_model="m",
        tools=reg,
        allowed_tool_names=None,
        disabled_tools=set(),
        emit_content=lambda _d: None,
        emit_reasoning=lambda _d: None,
    )
    assert result.kind == "answer"
    assert provider.last_tool_choice == "auto"
    assert set(provider.last_tool_names or []) == FINALIZE_COORDINATION_TOOLS


@pytest.mark.asyncio
async def test_soft_finalize_returns_coordination_tool_calls():
    provider = _ScriptedProvider([[_tool_chunk("delegate", '{"tasks":[]}')]])
    messages = [LLMMessage(role="user", content="go")]
    reg = _registry()
    result = await run_finalize_round(
        messages=messages,
        llm=provider,
        profile=make_profile_params(),
        active_model="m",
        tools=reg,
        allowed_tool_names=None,
        disabled_tools=set(),
        emit_content=lambda _d: None,
        emit_reasoning=lambda _d: None,
    )
    assert result.kind == "coordination_tools"
    assert result.tool_calls is not None
    assert result.tool_calls[0].function.name == "delegate"


@pytest.mark.asyncio
async def test_empty_soft_finalize_falls_back_to_tool_free():
    provider = _ScriptedProvider([[], [_content_chunk("hard answer")]])
    messages = [LLMMessage(role="user", content="go")]
    reg = _registry()
    content, _r, _u, _rounds, coordination = await force_finalize(
        messages=messages,
        llm=provider,
        profile=make_profile_params(),
        active_model="m",
        tools=reg,
        allowed_tool_names=None,
        disabled_tools=set(),
        emit_content=lambda _d: None,
        emit_reasoning=lambda _d: None,
        final_content="",
        final_reasoning="",
        total_usage=__import__(
            "agentcore.llm.provider.protocol", fromlist=["TokenUsage"]
        ).TokenUsage(),
        rounds=3,
        reason="convergence",
    )
    assert coordination is None
    assert content == "hard answer"
    assert provider.calls == 2
    assert provider.last_tool_choice == "none"
