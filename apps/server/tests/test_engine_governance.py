"""Integration tests for convergence governance wired into the ReAct loop.

Uses a scripted fake provider (no network) and a stub tool to drive the three
behaviors added to ``engine.react_loop``:
  * a repeated identical tool call → fact-anchored NUDGE, then FINALIZE
  * a repeated failing tool call → failure-flavored NUDGE
  * round-budget exhaustion mid-tool-call → forced tool-free answer (never blank)
"""

from pathlib import Path

from agentcore.core.types import ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry


def _tool_chunk(name: str, args: str, *, call_id: str = "c") -> LLMChunk:
    return LLMChunk(
        delta_tool_calls=[
            ToolCallDelta(index=0, id=call_id, function_name=name, arguments_delta=args)
        ]
    )


def _content_chunk(text: str) -> LLMChunk:
    return LLMChunk(delta_content=text)


class _ScriptedProvider:
    """Yields a pre-scripted list of chunks on each ``stream`` call (one per round)."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _StubTool:
    """A tool that records its call count and reports a fixed success/failure."""

    def __init__(self, name: str = "search", *, success: bool = True) -> None:
        self._name = name
        self._success = success
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        if self._success:
            return ToolResult(tool_call_id="", success=True, output="result")
        return ToolResult(tool_call_id="", success=False, output="", error="boom")


def _registry(tool: _StubTool) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(tool)
    return reg


def _context() -> ToolContext:
    return ToolContext(
        execution_id="e",
        step_id="s",
        agent_id="a",
        workspace_dir=Path("."),
        user_id="u",
    )


async def _run(provider: _ScriptedProvider, tool: _StubTool, *, max_rounds: int):
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=max_rounds)
    result = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
    )
    return result, messages


async def test_repeated_call_nudges_then_finalizes():
    same = _tool_chunk("search", '{"q": "x"}')
    # 3 identical calls → NUDGE; window clears; 3 more → FINALIZE → tool-free answer.
    provider = _ScriptedProvider(
        [[same], [same], [same], [same], [same], [same], [_content_chunk("final answer")]]
    )
    tool = _StubTool()
    (content, _r, _i, _o, _rt, rounds), messages = await _run(provider, tool, max_rounds=20)

    assert content == "final answer"
    assert rounds == 6  # finalized at the 6th round, before the cap
    assert tool.calls == 6
    # exactly one fact-anchored nudge was injected (repeated-call flavor)
    nudges = [m for m in messages if m.role == "user" and m.content and "停止重复" in m.content]
    assert len(nudges) == 1
    # and the forced-finalize instruction was injected once
    finalize = [
        m for m in messages if m.role == "user" and m.content and "停止使用任何工具" in m.content
    ]
    assert len(finalize) == 1


async def test_repeated_failure_nudge_is_failure_flavored():
    same = _tool_chunk("search", '{"q": "x"}')
    # 3 identical failures → NUDGE; round 3 the model gives a plain answer.
    provider = _ScriptedProvider(
        [[same], [same], [same], [_content_chunk("gave up, here is what I know")]]
    )
    tool = _StubTool(success=False)
    (content, *_), messages = await _run(provider, tool, max_rounds=20)

    assert content == "gave up, here is what I know"
    nudges = [m for m in messages if m.role == "user" and m.content and "失败" in m.content]
    assert len(nudges) == 1


async def test_max_rounds_exhaustion_forces_nonempty_answer():
    # Distinct args each round → governance never trips; the loop exhausts its
    # budget mid-tool-call and must force a tool-free answer (the bug fix:
    # previously it returned empty/partial content).
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "a"}')],
            [_tool_chunk("search", '{"q": "b"}')],
            [_tool_chunk("search", '{"q": "c"}')],
            [_content_chunk("best-effort fallback")],
        ]
    )
    tool = _StubTool()
    (content, _r, _i, _o, _rt, rounds), _messages = await _run(provider, tool, max_rounds=3)

    assert content == "best-effort fallback"
    assert rounds == 3  # reported as the cap → pipeline surfaces MAX_ROUNDS
    assert tool.calls == 3
    assert provider.calls == 4  # 3 loop rounds + 1 forced finalize


async def test_clean_answer_has_no_governance_injection():
    # A normal tool-then-answer turn must not inject any governance messages.
    provider = _ScriptedProvider(
        [[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]]
    )
    tool = _StubTool()
    (content, *_), messages = await _run(provider, tool, max_rounds=20)

    assert content == "done"
    assert tool.calls == 1
    assert not any(m.content and "[系统提示]" in m.content for m in messages if m.content)
