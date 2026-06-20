"""End-to-end pipeline tests: B2 governance finish_reason → message_end + persistence.

Drives the REAL chat pipeline (``run_chat_pipeline``) — the captain executor, the
``react_loop``, the ``LoopController`` governance, and the pipeline's finish-mapping —
with a scripted LLM provider and a controlled CEO toolset, proving the terminal
``FinishReason`` produced deep in the engine reaches BOTH ends the product reads:

* the ``message_end`` SSE event the client renders live, AND
* the persisted ``runs`` payload (``runs.finish_reason`` — the 唯一事实源 the turn
  journal stores and the bubble replays on reload).

The engine half (``react_loop`` → ``finish_override_sink``) is covered by
``test_engine_governance``; these lock the executor → ``captain_state.finish_override``
→ pipeline (``message_end`` / ``runs``) seam that carries it the rest of the way.

Only 无产出早停 (UNPRODUCTIVE) yields a non-default terminal reason; 工具失败熔断 /
反思注入 are mid-loop steers (injected into the transcript, asserted at the engine
level). So here we (1) prove UNPRODUCTIVE rides message_end + persistence, and (2)
prove a run that trips the circuit breaker but recovers still surfaces a clean
END_TURN — governance never mis-finishes a recovering turn.
"""

from pathlib import Path
from types import SimpleNamespace

from agentcore.core.types import ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.modes import ProfileSet
from agentcore.llm.protocol import LLMChunk, ToolCallDelta
from agentcore.runtime import pipeline
from agentcore.runtime.events import EventSink, EventType, FinishReason
from agentcore.tools.protocol import ToolResult, ToolSchema
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

    async def close(self) -> None:  # the pipeline awaits llm.close() in its finally
        return None


class _StubTool:
    """A CEO tool that reports a fixed success/failure (drives the governance path)."""

    def __init__(self, name: str = "flaky", *, success: bool = False) -> None:
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
        if not self._success:
            return ToolResult(tool_call_id="", success=False, output="", error="boom")
        return ToolResult(tool_call_id="", success=True, output="result")


def _patch_pipeline(monkeypatch, provider: _ScriptedProvider, registry: ToolRegistry):
    """Swap ONLY the LLM provider, the memory load, and the CEO toolset assembly for
    controlled doubles — everything that carries the finish_reason (captain executor,
    react_loop, LoopController governance, finish-mapping, message_end, runs payload)
    stays REAL."""
    monkeypatch.setattr(pipeline, "build_provider", lambda *a, **k: provider)

    class _FakeStore:
        async def load(self, _user_id: str) -> str:
            return ""

    monkeypatch.setattr(pipeline, "default_memory_store", lambda: _FakeStore())

    # delegate / revise are unused on this single-agent path, but the pipeline tail
    # folds their usage/ledger/citations — give it empty doubles.
    fake_delegate = SimpleNamespace(usage={}, run_ledger=[], citations=[])
    fake_revise = SimpleNamespace(usage={}, run_ledger=[], citations=[])
    fake_debate = SimpleNamespace(usage={}, run_ledger=[], citations=[])

    def _fake_assemble(**_kwargs):
        return fake_delegate, fake_revise, fake_debate, registry

    monkeypatch.setattr(pipeline, "_assemble_ceo_toolset", _fake_assemble)


async def _run_pipeline(
    monkeypatch, provider: _ScriptedProvider, registry: ToolRegistry
):
    _patch_pipeline(monkeypatch, provider, registry)
    sink = EventSink()
    profile = ModelProfile(
        model="chat-model", thinking=False, reasoning_effort=None, max_rounds=20
    )
    # The stub tool never touches the backend, so the root is inert — a plain path
    # (no tmp_path fixture) keeps this hermetic and dodges the Windows temp-symlink
    # teardown crash in pytest's tmp_path cleanup.
    backend = ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox())
    result = await pipeline.run_chat_pipeline(
        conversation_id="conv-1",
        user_message="去做点事",
        history=[],
        sink=sink,
        user_id="user-1",
        backend=backend,
        approvals_enabled=False,  # no live client → skip the approval/checkpoint gate
        profile_set=ProfileSet(profiles={"chat": profile}),
    )
    # run_chat_pipeline closes the sink in its finally, so the queue drains to the
    # None sentinel — collect every emitted event for the message_end assertion.
    events = [e async for e in sink]
    return result, events


def _message_end(events):
    return next(e for e in events if e.type == EventType.MESSAGE_END)


async def test_unproductive_early_stop_reaches_message_end_and_persisted_runs(
    monkeypatch,
):
    # Three rounds of a failing tool with no content → 无产出早停 → the loop force-
    # finalizes a salvaged answer and surfaces UNPRODUCTIVE. The reason must ride BOTH
    # the live message_end event AND the persisted runs payload.
    registry = ToolRegistry()
    registry.register(_StubTool(name="flaky", success=False))
    provider = _ScriptedProvider(
        [
            [_tool_chunk("flaky", '{"q": "a"}')],
            [_tool_chunk("flaky", '{"q": "b"}')],
            [_tool_chunk("flaky", '{"q": "c"}')],
            [_content_chunk("尽力给出的答复")],  # forced tool-free finalize
        ]
    )
    result, events = await _run_pipeline(monkeypatch, provider, registry)

    assert result["content"] == "尽力给出的答复"
    assert result["finish_reason"] == FinishReason.UNPRODUCTIVE
    # 1) the SSE message_end the client reads
    assert _message_end(events).payload["finish_reason"] == FinishReason.UNPRODUCTIVE
    # 2) the persisted runs payload (runs.finish_reason — journal 唯一事实源, stored as
    #    the string value that _persist_turn_result forwards to persist_turn_journal)
    assert result["runs"] is not None
    assert result["runs"]["finish_reason"] == FinishReason.UNPRODUCTIVE.value


async def test_circuit_breaker_run_that_recovers_finishes_end_turn(
    monkeypatch,
):
    # The tool fails 3× with varied args (circuit breaker warns@2 / disables@3) but the
    # model writes content each round (never unproductive) and then answers tool-free →
    # a clean END_TURN. Proves governance steers in a recovering run do NOT corrupt the
    # terminal reason, and the normal finish-mapping rides message_end + persistence.
    registry = ToolRegistry()
    registry.register(_StubTool(name="flaky", success=False))
    provider = _ScriptedProvider(
        [
            [_content_chunk("t0"), _tool_chunk("flaky", '{"q": "a"}')],
            [_content_chunk("t1"), _tool_chunk("flaky", '{"q": "b"}')],
            [_content_chunk("t2"), _tool_chunk("flaky", '{"q": "c"}')],
            [_content_chunk("最终答复")],
        ]
    )
    result, events = await _run_pipeline(monkeypatch, provider, registry)

    assert "最终答复" in result["content"]
    assert result["finish_reason"] == FinishReason.END_TURN
    assert _message_end(events).payload["finish_reason"] == FinishReason.END_TURN
    assert result["runs"] is not None
    assert result["runs"]["finish_reason"] == FinishReason.END_TURN.value
