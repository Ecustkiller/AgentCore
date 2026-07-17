"""Soft team-gate nudge for the CEO captain ReAct loop.

Covers investigation trigger, one-shot latch, worker isolation, and nudge copy
(threshold keywords). Scripted fake provider — zero LLM.

long_content post-hoc discard was removed; solo-collapse defense for early long
answers is prompt-side「路由自检」（see test_prompt / _CEO_CORE_HINT）.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.core.types import ToolCategory, ToolEffect
from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.engine import react_loop
from agentcore.runtime.engine.governance import team_gate_nudge_prompt
from agentcore.runtime.events import EventSink
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from tests.llm_helpers import make_profile_params


def _tool_chunk(name: str, args: str, *, call_id: str = "c") -> LLMChunk:
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

    async def stream(self, request):  # noqa: ANN001
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _StubTool:
    def __init__(
        self,
        name: str = "search",
        *,
        category: ToolCategory = ToolCategory.SEARCH,
    ) -> None:
        self._name = name
        self._category = category
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=self._category,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(
            tool_call_id="",
            success=True,
            output="result",
            effect=ToolEffect.CONTINUE,
        )


def _registry(*tools: _StubTool) -> ToolRegistry:
    reg = ToolRegistry()
    for tool in tools:
        reg.register(tool)
    return reg


def _context() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _team_gate_msgs(messages: list[LLMMessage]) -> list[LLMMessage]:
    return [
        m
        for m in messages
        if m.role == "user" and m.content and "组队门槛复核" in m.content
    ]


async def _run_captain(
    provider: _ScriptedProvider,
    tools: ToolRegistry,
    *,
    role: str = "captain",
    max_rounds: int = 20,
) -> tuple[str, list[LLMMessage]]:
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = make_profile_params(max_rounds=max_rounds)
    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=tools,
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
        turn_model="m",
        role=role,
    )
    return content, messages


def test_nudge_copy_cites_threshold_keywords():
    text = team_gate_nudge_prompt()
    assert "可分解" in text
    assert "质量面" in text
    assert "delegate" in text
    assert "闲聊" in text
    assert "单点事实" in text
    assert "追问" in text


@pytest.mark.asyncio
async def test_investigation_threshold_fires_once_for_captain():
    # ≥2 investigation calls then continue → soft gate once; subsequent rounds stay quiet.
    search = _StubTool(name="search")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "1"}')],
            [_tool_chunk("search", '{"q": "2"}')],
            [_tool_chunk("search", '{"q": "3"}')],
            [_content_chunk("ok")],
        ]
    )
    content, messages = await _run_captain(provider, _registry(search))

    assert content == "ok"
    gates = _team_gate_msgs(messages)
    assert len(gates) == 1
    assert "可分解" in (gates[0].content or "")
    assert "质量面" in (gates[0].content or "")


@pytest.mark.asyncio
async def test_below_investigation_threshold_no_gate():
    search = _StubTool(name="search")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "1"}')],
            [_content_chunk("short answer")],
        ]
    )
    content, messages = await _run_captain(provider, _registry(search))

    assert content == "short answer"
    assert _team_gate_msgs(messages) == []


@pytest.mark.asyncio
async def test_no_tool_long_answer_does_not_fire_team_gate():
    """long_content post-hoc discard removed: early long prose is kept as-is."""
    long = "甲" * 500
    provider = _ScriptedProvider([[_content_chunk(long)]])
    content, messages = await _run_captain(provider, _registry())

    assert content == long
    assert _team_gate_msgs(messages) == []


@pytest.mark.asyncio
async def test_no_tool_short_answer_no_gate():
    provider = _ScriptedProvider([[_content_chunk("嗯，好的")]])
    content, messages = await _run_captain(provider, _registry())

    assert content == "嗯，好的"
    assert _team_gate_msgs(messages) == []


@pytest.mark.asyncio
async def test_worker_role_never_fires():
    search = _StubTool(name="search")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "1"}')],
            [_tool_chunk("search", '{"q": "2"}')],
            [_tool_chunk("search", '{"q": "3"}')],
            [_content_chunk("甲" * 500)],
        ]
    )
    content, messages = await _run_captain(
        provider, _registry(search), role="worker"
    )

    assert "甲" in content
    assert _team_gate_msgs(messages) == []


@pytest.mark.asyncio
async def test_after_delegate_no_gate():
    # Once delegate has returned, further investigation must not trip the team-gate
    # (post-delegate steers are a separate mechanism).
    search = _StubTool(name="search")
    delegate = _StubTool(name="delegate", category=ToolCategory.ORCHESTRATION)
    provider = _ScriptedProvider(
        [
            [_tool_chunk("delegate", '{"tasks": []}', call_id="d1")],
            [_tool_chunk("search", '{"q": "1"}')],
            [_tool_chunk("search", '{"q": "2"}')],
            [_content_chunk("综述")],
        ]
    )
    content, messages = await _run_captain(provider, _registry(search, delegate))

    assert content == "综述"
    assert _team_gate_msgs(messages) == []


@pytest.mark.asyncio
async def test_investigation_fires_at_most_once():
    # Investigation gate first; further investigation rounds must not inject again.
    search = _StubTool(name="search")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "1"}')],
            [_tool_chunk("search", '{"q": "2"}')],
            [_tool_chunk("search", '{"q": "3"}')],
            [_content_chunk("甲" * 500)],
        ]
    )
    _content, messages = await _run_captain(provider, _registry(search))

    assert len(_team_gate_msgs(messages)) == 1
