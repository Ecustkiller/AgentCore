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

import asyncio
from pathlib import Path

import pytest

from agentcore.config import settings
from agentcore.core.types import ToolCategory, ToolEffect
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, TokenUsage, ToolCallDelta
from agentcore.runtime.engine import react_loop, resolve_tool_timeout
from agentcore.runtime.events import EventSink, FinishReason
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
        category: ToolCategory = ToolCategory.SEARCH,
    ) -> None:
        self._name = name
        self._success = success
        self._category = category
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
            category=self._category,
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
    # 3 identical failures → repeated-failure NUDGE; round 3 the model gives a plain
    # answer. (The cumulative circuit breaker also fires its own steers here — they're
    # a separate mechanism; this test pins the fingerprint-flavored nudge specifically.)
    provider = _ScriptedProvider(
        [[same], [same], [same], [_content_chunk("gave up, here is what I know")]]
    )
    tool = _StubTool(success=False)
    (content, *_), messages = await _run(provider, tool, max_rounds=20)

    assert content == "gave up, here is what I know"
    # the distinctive repeated-failure nudge (anchored to the exact-repeat count) is
    # injected exactly once
    nudges = [
        m
        for m in messages
        if m.role == "user" and m.content and "已用相同方式失败" in m.content
    ]
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


# --- B1: engine-level tool timeout backstop ----------------------------------


def _schema(category: ToolCategory, timeout: float | None = None) -> ToolSchema:
    return ToolSchema(
        name="t",
        description="d",
        parameters={"type": "object", "properties": {}},
        category=category,
        timeout_seconds=timeout,
    )


def test_resolve_tool_timeout_by_category():
    # The exemption policy is the part most likely to silently regress and break a
    # legitimate long wait (delegate's sub-DAG / ask_user's user round-trip), so pin it.
    assert resolve_tool_timeout(_schema(ToolCategory.ORCHESTRATION)) is None
    assert resolve_tool_timeout(_schema(ToolCategory.INTERACTION)) is None
    # execution runs code → higher ceiling; everything else → the flat default
    assert (
        resolve_tool_timeout(_schema(ToolCategory.EXECUTION))
        == settings.tool_execution_timeout_seconds
    )
    assert (
        resolve_tool_timeout(_schema(ToolCategory.SEARCH))
        == settings.tool_default_timeout_seconds
    )
    assert (
        resolve_tool_timeout(_schema(ToolCategory.FILESYSTEM))
        == settings.tool_default_timeout_seconds
    )
    # an explicit per-tool override wins over the category rule — even the exemption
    assert resolve_tool_timeout(_schema(ToolCategory.ORCHESTRATION, 12.5)) == 12.5
    assert resolve_tool_timeout(_schema(ToolCategory.EXECUTION, 5.0)) == 5.0


class _SlowTool:
    """A tool that sleeps well past its declared ceiling, to trip the engine timeout."""

    def __init__(self, *, delay: float, timeout_seconds: float | None) -> None:
        self._delay = delay
        self._timeout_seconds = timeout_seconds
        self.completed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="slow",
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
            timeout_seconds=self._timeout_seconds,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        await asyncio.sleep(self._delay)
        self.completed = True  # only reached if the timeout did NOT fire
        return ToolResult(tool_call_id="", success=True, output="late result")


async def test_tool_timeout_aborts_and_loop_recovers():
    # A tool that blows its (tiny) ceiling is aborted by the engine: the model gets a
    # timeout tool result it can adapt to, and the turn reaches an answer instead of
    # hanging on the wedged call. The tool's own body is cancelled (never completes).
    provider = _ScriptedProvider(
        [[_tool_chunk("slow", "{}")], [_content_chunk("recovered")]]
    )
    tool = _SlowTool(delay=5.0, timeout_seconds=0.05)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    content, _r, _u, _rounds = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
    )

    assert content == "recovered"
    assert tool.completed is False  # the sleep was cancelled, not awaited to the end
    tool_msg = next(m for m in messages if m.role == "tool")
    assert "中止" in (tool_msg.content or "")  # the model saw an honest timeout error


# --- B2: empty-response degraded + fallback model -----------------------------


class _ModelRecordingProvider:
    """Scripted provider that also records each request's model (to assert fallback)."""

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0
        self.models: list[str] = []

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        self.models.append(request.model)
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


async def _run_loop(provider, profile, *, finish_override_sink=None, tool=None):  # noqa: ANN001
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    return await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool or _StubTool()),
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
        finish_override_sink=finish_override_sink,
    )


async def test_empty_response_falls_back_to_stronger_model_and_recovers():
    # Round 0 is empty (no content, no tool) → the engine retries round 1 on the
    # profile's fallback model, which answers. The turn finishes clean (not degraded).
    provider = _ModelRecordingProvider([[], [_content_chunk("recovered")]])
    profile = ModelProfile(
        model="primary",
        fallback_model="fallback-pro",
        thinking=False,
        reasoning_effort=None,
        max_rounds=20,
    )
    finish_override: list[FinishReason] = []
    content, _r, _u, _rounds = await _run_loop(
        provider, profile, finish_override_sink=finish_override
    )

    assert content == "recovered"
    assert provider.models == ["primary", "fallback-pro"]  # escalated on the empty
    assert finish_override == []  # recovered → not degraded


async def test_consecutive_empty_after_fallback_finishes_degraded():
    # Round 0 empty → fallback; round 1 (on fallback) ALSO empty → the streak hits the
    # threshold → degraded finish (no blank-but-clean end_turn).
    provider = _ModelRecordingProvider([[], []])
    profile = ModelProfile(
        model="primary",
        fallback_model="fallback-pro",
        thinking=False,
        reasoning_effort=None,
        max_rounds=20,
    )
    finish_override: list[FinishReason] = []
    content, _r, _u, _rounds = await _run_loop(
        provider, profile, finish_override_sink=finish_override
    )

    assert content == ""
    assert provider.models == ["primary", "fallback-pro"]
    # surfaced as FinishReason.DEGRADED by the caller
    assert finish_override == [FinishReason.DEGRADED]


async def test_empty_response_degrades_without_fallback_model():
    # No fallback model configured: two consecutive empties go straight to degraded,
    # and the model is never switched.
    provider = _ModelRecordingProvider([[], []])
    profile = ModelProfile(
        model="primary",
        fallback_model=None,
        thinking=False,
        reasoning_effort=None,
        max_rounds=20,
    )
    finish_override: list[FinishReason] = []
    await _run_loop(provider, profile, finish_override_sink=finish_override)

    assert provider.models == ["primary", "primary"]  # no escalation
    assert finish_override == [FinishReason.DEGRADED]


# --- B2: tool failure circuit breaker + no-output early stop --------------------


class _ToolsRecordingProvider:
    """Scripted provider that records the tool names offered to it each round.

    Lets a test assert the circuit breaker actually removed a disabled tool from the
    toolset (request.tools) on the round after it tripped, not just that a steer was
    injected.
    """

    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0
        self.offered: list[list[str]] = []

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        self.offered.append([t["function"]["name"] for t in (request.tools or [])])
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


async def test_circuit_breaker_warns_then_disables_failing_tool():
    # `flaky` fails with DIFFERENT args every round (so fingerprint-keyed
    # REPEATED_FAILURE never trips) and the model writes content each round (so the
    # unproductive early-stop never trips) — isolating the cumulative circuit breaker:
    # warn at the 2nd failure, disable (remove from the toolset) at the 3rd.
    reg = ToolRegistry()
    reg.register(_StubTool(success=False, name="flaky"))
    reg.register(_StubTool(success=True, name="other"))
    provider = _ToolsRecordingProvider(
        [
            [_content_chunk("t0"), _tool_chunk("flaky", '{"q": "a"}')],
            [_content_chunk("t1"), _tool_chunk("flaky", '{"q": "b"}')],
            [_content_chunk("t2"), _tool_chunk("flaky", '{"q": "c"}')],
            [_content_chunk("done")],
        ]
    )
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    await react_loop(
        messages=messages,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
    )

    steers = [m.content or "" for m in messages if m.role == "user"]
    assert any("请不要再以相同方式调用" in s for s in steers)  # warn at 2 failures
    assert any("停用" in s for s in steers)  # disable at 3 failures
    # the disabled tool is gone from the toolset offered on the round AFTER disable
    assert provider.offered[0] == ["flaky", "other"]
    assert provider.offered[-1] == ["other"]


async def test_unproductive_rounds_early_stop_and_salvage_answer():
    # Every round: one tool call that FAILS (varied args → not a repeated pattern) and
    # no content. After the unproductive threshold (3) consecutive such rounds the loop
    # early-stops via a forced tool-free answer and surfaces FinishReason.UNPRODUCTIVE.
    flaky = _StubTool(success=False, name="flaky")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("flaky", '{"q": "a"}')],
            [_tool_chunk("flaky", '{"q": "b"}')],
            [_tool_chunk("flaky", '{"q": "c"}')],
            [_content_chunk("salvaged answer")],  # the forced finalize round
        ]
    )
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    finish_override: list[FinishReason] = []
    content, _r, _u, rounds = await _run_loop(
        provider, profile, finish_override_sink=finish_override, tool=flaky
    )

    assert content == "salvaged answer"
    assert rounds == 3  # stopped at the 3rd unproductive round, before the cap
    assert provider.calls == 4  # 3 loop rounds + 1 forced finalize
    assert finish_override == [FinishReason.UNPRODUCTIVE]


async def test_reflection_injected_on_long_run_cadence():
    # Distinct SUCCESSFUL tool calls each round (no repeat / failure / unproductive /
    # circuit-breaker interference) over a long run → only the periodic reflection
    # fires, on the round_idx 3 / 6 cadence (the 4th / 7th round), anchored to the
    # round number.
    rounds: list[list[LLMChunk]] = [
        [_tool_chunk("search", '{"q": "%d"}' % i)] for i in range(8)
    ]
    rounds.append([_content_chunk("final")])
    provider = _ScriptedProvider(rounds)
    (content, *_), messages = await _run(provider, _StubTool(), max_rounds=20)

    assert content == "final"
    reviews = [
        m
        for m in messages
        if m.role == "user" and m.content and "进度复盘" in m.content
    ]
    assert len(reviews) == 2  # injected after round_idx 3 and 6
    assert any("已进行 4 轮" in (m.content or "") for m in reviews)
    assert any("已进行 7 轮" in (m.content or "") for m in reviews)


async def test_productive_round_resets_unproductive_streak():
    # A round that produces content (even alongside a failing tool) breaks the streak,
    # so an intermittent failure run is NOT early-stopped as unproductive.
    flaky = _StubTool(success=False, name="flaky")
    provider = _ScriptedProvider(
        [
            [_tool_chunk("flaky", '{"q": "a"}')],  # unproductive (fail, no content)
            [_content_chunk("progress"), _tool_chunk("flaky", '{"q": "b"}')],  # resets
            [_tool_chunk("flaky", '{"q": "c"}')],  # streak restarts at 1
            [_content_chunk("final")],
        ]
    )
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    finish_override: list[FinishReason] = []
    content, _r, _u, _rounds = await _run_loop(
        provider, profile, finish_override_sink=finish_override, tool=flaky
    )

    # reached the model's own answer — never early-stopped
    assert "final" in content
    assert finish_override == []


# --- 档2.5: manager-CEO delegation breadth nudge (engine wiring) -----------------


def _read_then_answer(reads: int) -> _ScriptedProvider:
    # `reads` rounds of a read with DISTINCT args (so the repeated-call detector never
    # trips — isolating the breadth nudge), then a tool-free answer.
    rounds: list[list[LLMChunk]] = [
        [_tool_chunk("file_read", '{"p": "%d"}' % i)] for i in range(reads)
    ]
    rounds.append([_content_chunk("done")])
    return _ScriptedProvider(rounds)


async def _run_with_registry(provider: _ScriptedProvider, reg: ToolRegistry):
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]
    profile = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)
    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=reg,
        sink=EventSink(),
        tool_context=_context(),
        profile=profile,
    )
    return content, messages


async def test_delegation_breadth_nudge_fires_for_capable_run_investigating_solo():
    # A delegation-capable run (holds an ORCHESTRATION tool) that keeps doing read-only
    # investigation itself — read breadth crossing the default threshold (4) without a
    # delegate — gets exactly ONE breadth nudge to fan it out to a research team.
    reg = ToolRegistry()
    reg.register(_StubTool(name="file_read"))  # investigation (SEARCH + NEVER approval)
    reg.register(_StubTool(name="delegate", category=ToolCategory.ORCHESTRATION))
    content, messages = await _run_with_registry(_read_then_answer(4), reg)

    assert content == "done"
    nudges = [
        m for m in messages if m.role == "user" and m.content and "成规模的调查" in m.content
    ]
    assert len(nudges) == 1
    assert "4 次" in nudges[0].content and "delegate" in nudges[0].content
    # the periodic reflection (due at round_idx 3, the same round the nudge fires) is
    # suppressed so two steers don't stack in one round.
    assert not any(m.content and "进度复盘" in m.content for m in messages if m.content)


async def test_no_breadth_nudge_for_a_run_that_cannot_delegate():
    # A leaf worker (no ORCHESTRATION tool in its set) investigating broadly is doing
    # its own job — it must never be told to delegate, no matter how much it reads.
    reg = ToolRegistry()
    reg.register(_StubTool(name="file_read"))
    content, messages = await _run_with_registry(_read_then_answer(5), reg)

    assert content == "done"
    assert not any(m.content and "成规模的调查" in m.content for m in messages if m.content)


async def test_no_breadth_nudge_once_the_run_delegates():
    # A capable run that DOES delegate early is behaving as a manager: a couple of
    # scout reads before the delegate, then more reads after the result comes back,
    # must not trip the nudge (the delegate latches it off for the rest of the run).
    reg = ToolRegistry()
    reg.register(_StubTool(name="file_read"))
    reg.register(_StubTool(name="delegate", category=ToolCategory.ORCHESTRATION))
    provider = _ScriptedProvider(
        [
            [_tool_chunk("file_read", '{"p": "scout"}')],  # 1 scout read
            [_tool_chunk("delegate", "{}")],  # delegates → behaving as a manager
            [_tool_chunk("file_read", '{"p": "a"}')],  # post-result reads...
            [_tool_chunk("file_read", '{"p": "b"}')],
            [_tool_chunk("file_read", '{"p": "c"}')],
            [_tool_chunk("file_read", '{"p": "d"}')],
            [_content_chunk("done")],
        ]
    )
    content, messages = await _run_with_registry(provider, reg)

    assert content == "done"
    assert not any(m.content and "成规模的调查" in m.content for m in messages if m.content)
