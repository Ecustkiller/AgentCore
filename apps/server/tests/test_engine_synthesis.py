"""Tests for the CEO synthesis phase wired into the ReAct loop (D3 / Phase B).

When ``react_loop`` is given a ``synthesis_run_id`` and the captain resumes after
a non-terminal ORCHESTRATION tool (``delegate``) returns, the integration round
must:
  * fire ``begin_synthesis`` exactly once (the caller declares + starts the run),
  * stream that round's reasoning as a RUN-scoped ``run_reasoning_delta`` (the
    team's 「汇总过程」) and NOT fold it into the chat bubble's thinking,
  * stream that round's content to the chat bubble AND mirror it to the node via
    ``run_output_delta``.

Absent the synthesis wiring (workers / non-delegating turns) the loop behaves
exactly as before — verified here so the feature is provably inert by default.
"""

from pathlib import Path

from agentcore.core.types import ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink, EventType, run_plan, run_started
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _tool_chunk(name: str, args: str, *, reasoning: str | None = None) -> LLMChunk:
    return LLMChunk(
        delta_reasoning=reasoning,
        delta_tool_calls=[
            ToolCallDelta(index=0, id="c", function_name=name, arguments_delta=args)
        ],
    )


def _content_chunk(text: str, *, reasoning: str | None = None) -> LLMChunk:
    return LLMChunk(delta_content=text, delta_reasoning=reasoning)


class _ScriptedProvider:
    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _StubTool:
    """A non-terminal tool whose category is configurable (ORCHESTRATION = the
    delegate primitive that triggers synthesis; SEARCH = an ordinary tool that
    must NOT)."""

    def __init__(self, name: str, *, category: ToolCategory) -> None:
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
        return ToolResult(tool_call_id="", success=True, output="workers done")


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


def _journal_deltas(sink: EventSink, event_type: EventType) -> list[dict]:
    return [
        e["payload"]
        for e in sink.execution_journal() or []
        if e["type"] == event_type.value
    ]


async def test_delegate_resume_routes_synthesis_round_to_node():
    # Round 0: plan + delegate. Round 1: the synthesis round (reasoning = 汇总过程,
    # content = the user-facing overview).
    provider = _ScriptedProvider(
        [
            [_tool_chunk("delegate", "{}", reasoning="PLAN")],
            [_content_chunk("OVERVIEW", reasoning="SYNTH")],
        ]
    )
    tool = _StubTool("delegate", category=ToolCategory.ORCHESTRATION)
    sink = EventSink()
    began = 0

    def _begin() -> None:
        # Mirror the pipeline: declaring the synthesis run is what makes the
        # turn's journal non-empty (execution_journal gates on a run_plan).
        nonlocal began
        began += 1
        sink.emit(
            run_plan(
                execution_id="e",
                plan_type="multi_agent",
                task_summary="",
                agents=[{"id": "ceo", "role": "CEO"}],
                runs=[{"id": "syn", "agent_id": "ceo", "task": "汇总", "depends_on": [], "kind": "synthesis"}],
            )
        )
        sink.emit(run_started("syn", "ceo", kind="synthesis"))

    content, reasoning, _usage, rounds = await react_loop(
        messages=[LLMMessage(role="user", content="go")],
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=ModelProfile(model="m", thinking=True, reasoning_effort="high", max_rounds=20),
        synthesis_run_id="syn",
        synthesis_agent_id="ceo",
        begin_synthesis=_begin,
    )

    assert content == "OVERVIEW"
    # planning reasoning stays on the chat bubble; synthesis reasoning does NOT
    assert reasoning == "PLAN"
    assert began == 1
    assert rounds == 2
    # synthesis reasoning is journaled run-scoped to the synthesis node
    rdeltas = _journal_deltas(sink, EventType.RUN_REASONING_DELTA)
    assert rdeltas == [{"run_id": "syn", "agent_id": "ceo", "delta": "SYNTH"}]
    # and the overview is mirrored to the node's output (and still streamed to chat)
    odeltas = _journal_deltas(sink, EventType.RUN_OUTPUT_DELTA)
    assert odeltas == [{"run_id": "syn", "agent_id": "ceo", "delta": "OVERVIEW"}]


async def test_non_orchestration_tool_does_not_trigger_synthesis():
    # A plain (SEARCH) tool resume must NOT enter synthesis mode, even with the
    # synthesis wiring supplied — only the delegate primitive flips the boundary.
    provider = _ScriptedProvider(
        [
            [_tool_chunk("search", "{}", reasoning="PLAN")],
            [_content_chunk("ANSWER", reasoning="MORE")],
        ]
    )
    tool = _StubTool("search", category=ToolCategory.SEARCH)
    sink = EventSink()
    began = 0

    def _begin() -> None:
        nonlocal began
        began += 1

    content, reasoning, _usage, _rounds = await react_loop(
        messages=[LLMMessage(role="user", content="go")],
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=ModelProfile(model="m", thinking=True, reasoning_effort="high", max_rounds=20),
        synthesis_run_id="syn",
        synthesis_agent_id="ceo",
        begin_synthesis=_begin,
    )

    assert content == "ANSWER"
    assert reasoning == "PLANMORE"  # all reasoning folded into the chat bubble
    assert began == 0
    assert _journal_deltas(sink, EventType.RUN_REASONING_DELTA) == []
    assert _journal_deltas(sink, EventType.RUN_OUTPUT_DELTA) == []


async def test_no_synthesis_wiring_leaves_loop_unchanged():
    # Without synthesis ids, a delegate resume behaves exactly as before: no
    # run-scoped synthesis deltas, all reasoning on the bubble.
    provider = _ScriptedProvider(
        [
            [_tool_chunk("delegate", "{}", reasoning="PLAN")],
            [_content_chunk("OVERVIEW", reasoning="SYNTH")],
        ]
    )
    tool = _StubTool("delegate", category=ToolCategory.ORCHESTRATION)
    sink = EventSink()

    content, reasoning, _usage, _rounds = await react_loop(
        messages=[LLMMessage(role="user", content="go")],
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=ModelProfile(model="m", thinking=True, reasoning_effort="high", max_rounds=20),
    )

    assert content == "OVERVIEW"
    assert reasoning == "PLANSYNTH"
    assert _journal_deltas(sink, EventType.RUN_REASONING_DELTA) == []
    assert _journal_deltas(sink, EventType.RUN_OUTPUT_DELTA) == []
