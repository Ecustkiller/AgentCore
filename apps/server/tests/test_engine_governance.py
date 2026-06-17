"""Integration tests for convergence governance wired into the ReAct loop.

Uses a scripted fake provider (no network) and a stub tool to drive the three
behaviors added to ``engine.react_loop``:
  * a repeated identical tool call → fact-anchored NUDGE, then FINALIZE
  * a repeated failing tool call → failure-flavored NUDGE
  * round-budget exhaustion mid-tool-call → forced tool-free answer (never blank)

The same harness also covers per-turn citation aggregation and the A2 citation
numbering (engine-assigned card numbers folded back into the tool output so the
model cites by a number that always lines up with the card).
"""

from pathlib import Path

import pytest

from agentcore.core.types import ToolCategory, ToolEffect
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, TokenUsage, ToolCallDelta
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


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
    """A tool that records its call count and reports a fixed success/failure.

    Optionally carries ``citations`` (research-tool data) and/or behaves as a
    ``terminal`` handoff tool — used to verify the loop's citation aggregation,
    including the handoff early-return path.
    """

    def __init__(
        self,
        name: str = "search",
        *,
        success: bool = True,
        citations: list[dict] | None = None,
        citation_script: list[list[dict]] | None = None,
        terminal: bool = False,
        fail_output: str = "",
    ) -> None:
        self._name = name
        self._success = success
        self._citations = citations
        # Diagnostic detail a failing tool puts in ``output`` (mirrors code_execute,
        # whose stdout/stderr ride output while ``error`` is just the exit code).
        self._fail_output = fail_output
        # Per-call citation lists (i-th call returns the i-th list); lets a test
        # drive multi-round dedup/numbering. Overrides ``citations`` when set.
        self._citation_script = citation_script
        self._terminal = terminal
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
        call_index = self.calls
        self.calls += 1
        if not self._success:
            return ToolResult(
                tool_call_id="", success=False, output=self._fail_output, error="boom"
            )
        if self._citation_script is not None:
            citations = (
                self._citation_script[call_index]
                if call_index < len(self._citation_script)
                else None
            )
        else:
            citations = self._citations
        return ToolResult(
            tool_call_id="",
            success=True,
            output="result",
            citations=citations,
            effect=ToolEffect.HANDOFF if self._terminal else ToolEffect.CONTINUE,
            final_text="streamed answer" if self._terminal else None,
        )


def _registry(tool: _StubTool) -> ToolRegistry:
    reg = ToolRegistry()
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


async def _run(
    provider: _ScriptedProvider,
    tool: _StubTool,
    *,
    max_rounds: int,
    citation_sink: list[dict] | None = None,
    annotate_citations: bool = True,
):
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=max_rounds)
    result = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
        citation_sink=citation_sink,
        annotate_citations=annotate_citations,
    )
    return result, messages


async def test_repeated_call_nudges_then_finalizes():
    same = _tool_chunk("search", '{"q": "x"}')
    # 3 identical calls → NUDGE; window clears; 3 more → FINALIZE → tool-free answer.
    provider = _ScriptedProvider(
        [[same], [same], [same], [same], [same], [same], [_content_chunk("final answer")]]
    )
    tool = _StubTool()
    (content, _r, _usage, rounds), messages = await _run(provider, tool, max_rounds=20)

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


async def test_failed_tool_surfaces_diagnostic_output_not_just_error():
    # 失败的工具结果必须把 output（如 code_execute 的 stdout/stderr）连同 error 一起回给
    # model——否则模型只看到「boom」这种干巴巴的 error、对真实报错盲调（曾导致 worker 反复
    # 乱试 bash 才发现 bash 在本机不可用）。这里模拟 code_execute 失败：error 简短、真正的
    # 诊断在 output 里。
    call = _tool_chunk("search", "{}")
    provider = _ScriptedProvider([[call], [_content_chunk("ok")]])
    tool = _StubTool(success=False, fail_output="stderr:\nexecvpe(/bin/bash) failed")
    _result, messages = await _run(provider, tool, max_rounds=20)

    tool_msg = next(m for m in messages if m.role == "tool")
    assert "boom" in (tool_msg.content or "")  # error 摘要保留
    assert "execvpe(/bin/bash) failed" in (tool_msg.content or "")  # 诊断细节被回显


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
    (content, _r, _usage, rounds), _messages = await _run(provider, tool, max_rounds=3)

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


async def test_research_tool_citations_collected_into_sink():
    # A successful research tool's citations land in the caller's sink.
    cites = [{"url": "https://a.com", "title": "A", "snippet": "s", "site": "a.com"}]
    provider = _ScriptedProvider(
        [[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]]
    )
    sink_list: list[dict] = []
    (content, *_), _ = await _run(
        provider, _StubTool(citations=cites), max_rounds=20, citation_sink=sink_list
    )

    assert content == "done"
    assert sink_list == cites


async def test_terminal_tool_citations_collected_before_handoff():
    # A handoff (terminal) tool returns early, but its citations must still be
    # merged into the sink first — the multi-agent → chat-turn source path.
    cites = [{"url": "https://t.com", "title": "T", "snippet": "", "site": "t.com"}]
    provider = _ScriptedProvider([[_tool_chunk("assemble", "{}")]])
    sink_list: list[dict] = []
    (content, *_), _ = await _run(
        provider,
        _StubTool(name="assemble", citations=cites, terminal=True),
        max_rounds=20,
        citation_sink=sink_list,
    )

    assert content == "streamed answer"  # final_text surfaced as the reply
    assert sink_list == cites


async def test_citation_numbers_injected_into_tool_output():
    # A2: the engine annotates the tool's model-facing output with the canonical
    # numbers it assigned each source, so the model cites by a card-aligned number
    # instead of guessing one.
    cites = [
        {"url": "https://a.com", "title": "A", "snippet": "", "site": "a.com"},
        {"url": "https://b.com", "title": "B", "snippet": "", "site": "b.com"},
    ]
    provider = _ScriptedProvider(
        [[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]]
    )
    sink_list: list[dict] = []
    (content, *_), messages = await _run(
        provider, _StubTool(citations=cites), max_rounds=20, citation_sink=sink_list
    )

    assert content == "done"
    # cards aggregated in arrival order
    assert [c["url"] for c in sink_list] == ["https://a.com", "https://b.com"]
    # the tool message now carries the source→number annotation (number == card)
    tool_msg = next(m for m in messages if m.role == "tool")
    assert "[来源编号]" in (tool_msg.content or "")
    assert "[1]=https://a.com" in tool_msg.content
    assert "[2]=https://b.com" in tool_msg.content


async def test_citation_numbers_stable_across_rounds_with_dedup():
    # Round 1 surfaces A,B; round 2 re-surfaces B (dedup) and adds C. B's card
    # must keep number 2 and C must get the next free number (3) — and each
    # round's annotation tells the model exactly that, so multi-search + dedup
    # never drifts the body [n] ↔ card mapping.
    round1 = [
        {"url": "https://a.com", "title": "A", "snippet": "", "site": "a.com"},
        {"url": "https://b.com", "title": "B", "snippet": "", "site": "b.com"},
    ]
    round2 = [
        {"url": "https://b.com/#x", "title": "B again", "snippet": "", "site": "b.com"},
        {"url": "https://c.com", "title": "C", "snippet": "", "site": "c.com"},
    ]
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", '{"q": "1"}', call_id="c1")],
            [_tool_chunk("search", '{"q": "2"}', call_id="c2")],
            [_content_chunk("done")],
        ]
    )
    sink_list: list[dict] = []
    (content, *_), messages = await _run(
        provider,
        _StubTool(citation_script=[round1, round2]),
        max_rounds=20,
        citation_sink=sink_list,
    )

    assert content == "done"
    # dedup: B appears once; cards are A,B,C in arrival order
    assert [c["url"] for c in sink_list] == [
        "https://a.com",
        "https://b.com",
        "https://c.com",
    ]
    tool_msgs = [m for m in messages if m.role == "tool"]
    assert len(tool_msgs) == 2
    # round 1 annotation: A=1, B=2
    assert "[1]=https://a.com" in (tool_msgs[0].content or "")
    assert "[2]=https://b.com" in tool_msgs[0].content
    # round 2 annotation: B reuses 2 (dedup), C gets 3 — numbers stay card-aligned
    assert "[2]=https://b.com/#x" in (tool_msgs[1].content or "")
    assert "[3]=https://c.com" in tool_msgs[1].content


async def test_worker_path_collects_citations_without_annotating():
    # Worker path (annotate_citations=False, 方案 B): the worker's sources are still
    # aggregated into the sink (so the DelegateTool can fold them into the turn's
    # shared card) but the worker's tool output is left un-numbered — its local
    # numbering would be re-ordered when merged into the turn card and would mislead.
    cites = [
        {"url": "https://a.com", "title": "A", "snippet": "", "site": "a.com"},
        {"url": "https://b.com", "title": "B", "snippet": "", "site": "b.com"},
    ]
    provider = _ScriptedProvider(
        [[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]]
    )
    sink_list: list[dict] = []
    (content, *_), messages = await _run(
        provider,
        _StubTool(citations=cites),
        max_rounds=20,
        citation_sink=sink_list,
        annotate_citations=False,
    )

    assert content == "done"
    # collected for the shared card, in arrival order
    assert [c["url"] for c in sink_list] == ["https://a.com", "https://b.com"]
    # but the worker's tool message is NOT annotated with [n]=url numbers
    tool_msg = next(m for m in messages if m.role == "tool")
    assert tool_msg.content == "result"
    assert "[来源编号]" not in (tool_msg.content or "")


# --- usage_sink: partial usage survives a mid-loop raise (B-deep 失败计费) ----


class _MeterThenBoom:
    """Round 0 meters usage (a tool call so the loop continues + a usage chunk);
    round 1 raises. With raise_on_error=True the loop re-raises — but the round
    that completed must still be readable via usage_sink so the caller can bill it."""

    def __init__(self) -> None:
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        c = self.calls
        self.calls += 1
        if c == 0:
            yield _tool_chunk("search", "{}")
            yield LLMChunk(
                usage=TokenUsage(input_tokens=1000, cache_miss_tokens=1000, output_tokens=400)
            )
            return
        raise RuntimeError("provider down")
        yield  # pragma: no cover - makes this an async generator


async def test_usage_sink_holds_completed_round_usage_on_raise():
    sink_usage: list[TokenUsage] = []
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    with pytest.raises(RuntimeError, match="provider down"):
        await react_loop(
            messages=[LLMMessage(role="user", content="go")],
            llm=_MeterThenBoom(),
            tools=_registry(_StubTool()),
            sink=EventSink(),
            tool_context=_context(),
            profile=profile,
            raise_on_error=True,
            usage_sink=sink_usage,
        )
    # The round that completed before the crash is mirrored for the caller to bill.
    assert len(sink_usage) == 1
    assert sink_usage[0].cache_miss_tokens == 1000
    assert sink_usage[0].output_tokens == 400


async def test_usage_sink_empty_when_first_round_raises():
    # Nothing metered before the crash → the mirror stays empty, so the caller bills
    # nothing (no spurious zero-usage ledger row).
    class _BoomFirst:
        async def stream(self, request):  # noqa: ANN001
            raise RuntimeError("down")
            yield  # pragma: no cover

    sink_usage: list[TokenUsage] = []
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    with pytest.raises(RuntimeError, match="down"):
        await react_loop(
            messages=[LLMMessage(role="user", content="go")],
            llm=_BoomFirst(),
            tools=_registry(_StubTool()),
            sink=EventSink(),
            tool_context=_context(),
            profile=profile,
            raise_on_error=True,
            usage_sink=sink_usage,
        )
    assert sink_usage == []
