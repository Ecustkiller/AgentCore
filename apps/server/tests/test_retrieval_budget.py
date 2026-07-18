"""检索预算 A1: structured defaults, explicit override, tool_exec charge / exhaust."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agentcore.core.types import ToolCategory
from agentcore.llm.provider.protocol import ToolCall, ToolCallFunction
from agentcore.runtime.engine.tool_exec import execute_tools
from agentcore.runtime.events import EventSink
from agentcore.runtime.runs.builder import build_run_plan
from agentcore.runtime.runs.retrieval_budget import (
    BUDGET_EXHAUSTED_FEEDBACK,
    DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM,
    DEFAULT_RETRIEVAL_BUDGET_ROOT,
    RETRIEVAL_TOOL_NAMES,
    charges_retrieval_budget,
    default_retrieval_budget,
    format_retrieval_budget_line,
)
from agentcore.runtime.runs.types import Deliverable, RunSpec
from agentcore.tools.protocol import RetrievalBudgetState, ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _spec(
    *,
    deps: list[str] | None = None,
    form: str | None = None,
    budget: int | None = None,
    tools: list[str] | None = None,
) -> RunSpec:
    deliverable = Deliverable(form=form) if form else None  # type: ignore[arg-type]
    return RunSpec(
        run_id="n1",
        task="t",
        role="r",
        depends_on=deps or [],
        deliverable=deliverable,
        retrieval_budget=budget,
        tools=tools,
    )


def test_structured_default_root_no_deps():
    assert default_retrieval_budget(_spec()) == DEFAULT_RETRIEVAL_BUDGET_ROOT


def test_structured_default_prose_downstream_is_zero():
    assert (
        default_retrieval_budget(_spec(deps=["up"], form="prose")) == 0
    )


def test_structured_default_other_downstream_is_small():
    assert (
        default_retrieval_budget(_spec(deps=["up"], form="files"))
        == DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM
    )
    assert (
        default_retrieval_budget(_spec(deps=["up"]))
        == DEFAULT_RETRIEVAL_BUDGET_DOWNSTREAM
    )


def test_build_plan_applies_defaults_and_strips_search_for_prose_downstream():
    valid = {"web_search", "read_url", "file_read", "handoff", "escalate"}
    plan, errors = build_run_plan(
        [
            {"id": "r1", "role": "研究员", "task": "调研竞品"},
            {
                "id": "w1",
                "role": "写手",
                "task": "综合成文",
                "depends_on": ["r1"],
                "deliverable": {"form": "prose"},
            },
        ],
        valid_tools=valid,
    )
    assert errors == []
    by_role = {n.role: n for n in plan.nodes}
    assert by_role["研究员"].retrieval_budget == DEFAULT_RETRIEVAL_BUDGET_ROOT
    assert by_role["写手"].retrieval_budget == 0
    writer_tools = by_role["写手"].tools
    assert writer_tools is not None
    assert "web_search" not in writer_tools
    assert "read_url" not in writer_tools
    assert "file_read" in writer_tools


def test_ceo_explicit_budget_overrides_default():
    plan, errors = build_run_plan(
        [
            {"id": "r", "role": "研究员", "task": "深挖", "retrieval_budget": 20},
            {
                "id": "w",
                "role": "写手",
                "task": "写",
                "depends_on": ["r"],
                "deliverable": {"form": "prose"},
                "retrieval_budget": 2,
            },
        ],
        valid_tools={"web_search", "read_url", "file_read"},
    )
    assert errors == []
    by_role = {n.role: n for n in plan.nodes}
    assert by_role["研究员"].retrieval_budget == 20
    assert by_role["写手"].retrieval_budget == 2
    # explicit non-zero ⇒ do not strip retrieval tools (unrestricted stays None)
    assert by_role["写手"].tools is None


def test_charges_skips_cache_and_failures():
    ok_live = ToolResult(tool_call_id="", success=True, output="x", metadata={})
    ok_cached = ToolResult(
        tool_call_id="", success=True, output="x", metadata={"cached": True}
    )
    failed = ToolResult(tool_call_id="", success=False, output="", error="A3 reject")
    assert charges_retrieval_budget(ok_live) is True
    assert charges_retrieval_budget(ok_cached) is False
    assert charges_retrieval_budget(failed) is False


def test_budget_line_mentions_continue_from():
    line = format_retrieval_budget_line(5)
    assert "5" in line
    assert "continue_from_run_id" in line
    zero = format_retrieval_budget_line(0)
    assert "0" in zero
    assert "不装配" in zero


def _ctx(*, budget: RetrievalBudgetState | None) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="r1",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        retrieval_budget=budget,
    )


def _call(tool_id: str, name: str = "web_search") -> ToolCall:
    return ToolCall(
        id=tool_id,
        function=ToolCallFunction(name=name, arguments='{"query":"q"}'),
    )


class _SearchStub:
    def __init__(self, *, cached: bool = False, fail: bool = False) -> None:
        self.calls = 0
        self._cached = cached
        self._fail = fail

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="web_search",
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.calls += 1
        if self._fail:
            return ToolResult(tool_call_id="", success=False, error="bad query")
        meta = {"cached": True} if self._cached else {}
        return ToolResult(tool_call_id="", success=True, output="hits", metadata=meta)


@pytest.mark.asyncio
async def test_tool_exec_exhausts_and_returns_structured_feedback():
    stub = _SearchStub()
    reg = ToolRegistry()
    reg.register(stub)
    state = RetrievalBudgetState(limit=1)
    sink = EventSink()

    msgs1, _, _ = await execute_tools(
        [_call("c1")], reg, _ctx(budget=state), sink, run_id="r1"
    )
    assert stub.calls == 1
    assert state.used == 1
    assert "hits" in (msgs1[0].content or "")

    msgs2, _, _ = await execute_tools(
        [_call("c2")], reg, _ctx(budget=state), sink, run_id="r1"
    )
    assert stub.calls == 1  # second call blocked
    assert BUDGET_EXHAUSTED_FEEDBACK in (msgs2[0].content or "")
    assert "continue_from_run_id" in (msgs2[0].content or "")
    assert state.used == 1


@pytest.mark.asyncio
async def test_tool_exec_cache_hit_does_not_consume_budget():
    stub = _SearchStub(cached=True)
    reg = ToolRegistry()
    reg.register(stub)
    state = RetrievalBudgetState(limit=1)
    sink = EventSink()

    await execute_tools([_call("c1")], reg, _ctx(budget=state), sink, run_id="r1")
    assert stub.calls == 1
    assert state.used == 0

    # still have budget for a live call
    stub2 = _SearchStub(cached=False)
    reg2 = ToolRegistry()
    reg2.register(stub2)
    await execute_tools([_call("c2")], reg2, _ctx(budget=state), sink, run_id="r1")
    assert stub2.calls == 1
    assert state.used == 1


@pytest.mark.asyncio
async def test_tool_exec_failed_call_does_not_consume_budget():
    stub = _SearchStub(fail=True)
    reg = ToolRegistry()
    reg.register(stub)
    state = RetrievalBudgetState(limit=1)
    sink = EventSink()

    await execute_tools([_call("c1")], reg, _ctx(budget=state), sink, run_id="r1")
    assert stub.calls == 1
    assert state.used == 0


def test_retrieval_tool_names_cover_search_and_read():
    assert frozenset({"web_search", "read_url"}) == RETRIEVAL_TOOL_NAMES
