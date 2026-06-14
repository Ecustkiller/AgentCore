"""Tests for DelegateTool (统一 Run 模型 阶段3, Option 1 非-terminal).

Drives the tool end to end with a scripted fake provider (no network): it builds
a RunPlan from inline-role tasks, runs the workers through the WaveScheduler, and
returns their products to the CEO as a **non-terminal** result (so the CEO
synthesizes the final answer itself). Also covers rejection of bad task batches,
worker token accumulation, and the graph lifecycle events.
"""

from pathlib import Path

from agentcore.llm.protocol import LLMChunk, TokenUsage
from agentcore.runtime.events import EventSink, EventType
from agentcore.tools.builtin.delegate import DelegateTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


class _Provider:
    """Fake LLM: one scripted content chunk per call, optionally a usage chunk."""

    def __init__(self, contents: list[str], usage: TokenUsage | None = None) -> None:
        self._contents = contents
        self._usage = usage
        self.calls = 0

    async def stream(self, request):
        text = self._contents[self.calls] if self.calls < len(self._contents) else "done"
        self.calls += 1
        yield LLMChunk(delta_content=text)
        if self._usage is not None:
            yield LLMChunk(usage=self._usage)


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _tool(provider: _Provider, sink: EventSink | None = None) -> DelegateTool:
    return DelegateTool(
        llm=provider,
        sink=sink or EventSink(),
        system_prompt="SYS",
        user_message="原始请求",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=_ctx(),
    )


async def test_parallel_delegate_returns_products_non_terminal():
    tool = _tool(_Provider(["AOUT", "BOUT"]))
    result = await tool.execute(
        {"tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}]}, _ctx()
    )
    assert result.success is True
    assert result.terminal is False
    assert "AOUT" in result.output
    assert "BOUT" in result.output
    assert "研究员" in result.output
    assert "写手" in result.output
    assert set(result.metadata) == {
        "input_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cache_hit_tokens",
        "cache_miss_tokens",
    }


async def test_dag_delegate_completes_with_both_products():
    tasks = [
        {"id": "s1", "role": "研究员", "task": "调研"},
        {"id": "s2", "role": "写手", "task": "撰写", "depends_on": ["s1"]},
    ]
    tool = _tool(_Provider(["UPSTREAM", "FINAL"]))
    result = await tool.execute({"tasks": tasks}, _ctx())
    assert result.success is True
    assert result.terminal is False
    assert "UPSTREAM" in result.output
    assert "FINAL" in result.output


async def test_empty_tasks_rejected():
    tool = _tool(_Provider([]))
    result = await tool.execute({"tasks": []}, _ctx())
    assert result.success is False
    assert result.terminal is False
    assert result.error


async def test_all_invalid_tasks_rejected():
    tool = _tool(_Provider([]))
    result = await tool.execute({"tasks": [{"role": "A"}]}, _ctx())  # missing task
    assert result.success is False
    assert result.error


async def test_worker_usage_accumulates_across_calls():
    # The cache hit/miss split rides along with the basic counts so the folded
    # turn total stays priceable.
    usage = TokenUsage(
        input_tokens=10,
        output_tokens=5,
        reasoning_tokens=2,
        cache_hit_tokens=6,
        cache_miss_tokens=4,
    )
    tool = _tool(_Provider(["X", "Y", "Z", "W"], usage=usage))
    first = await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _ctx())
    assert first.metadata["input_tokens"] == 10
    assert first.metadata["cache_hit_tokens"] == 6
    assert tool.usage == {
        "input": 10,
        "output": 5,
        "reasoning": 2,
        "cache_hit": 6,
        "cache_miss": 4,
    }
    await tool.execute({"tasks": [{"role": "B", "task": "b"}]}, _ctx())
    assert tool.usage == {
        "input": 20,
        "output": 10,
        "reasoning": 4,
        "cache_hit": 12,
        "cache_miss": 8,
    }


async def test_emits_plan_and_lifecycle_events():
    sink = EventSink()
    tool = _tool(_Provider(["X"]), sink=sink)
    await tool.execute({"tasks": [{"role": "A", "task": "做A"}]}, _ctx())
    sink.close()
    types = [e.type async for e in sink]
    assert EventType.RUN_PLAN in types
    assert EventType.RUN_STARTED in types
    assert EventType.RUN_COMPLETED in types
    assert EventType.RUN_PROGRESS in types


async def test_second_call_namespaces_run_ids():
    sink = EventSink()
    tool = _tool(_Provider(["X", "Y"]), sink=sink)
    await tool.execute({"tasks": [{"role": "A", "task": "a"}]}, _ctx())
    await tool.execute({"tasks": [{"role": "B", "task": "b"}]}, _ctx())
    sink.close()
    starts = [e async for e in sink if e.type == EventType.RUN_STARTED]
    run_ids = [e.payload["run_id"] for e in starts]
    assert len(run_ids) == 2
    assert run_ids[0] != run_ids[1]  # distinct namespacing across delegate calls
