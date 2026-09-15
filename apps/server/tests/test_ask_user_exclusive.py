"""ask_user may pause at most once per model round; other tools may run first."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agentcore.core.types import ToolEffect, ToolFace
from agentcore.llm.provider.protocol import ToolCall, ToolCallFunction
from agentcore.runtime.engine.ask_user_exclusive import (
    ASK_USER_NOT_EXCLUSIVE_MSG,
    exclusive_ask_user_violation,
)
from agentcore.runtime.engine.tool_exec import execute_tools
from agentcore.runtime.events import EventSink
from agentcore.runtime.facts import FactKind, TurnFactLog, current_fact_log
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx() -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _call(tool_id: str, name: str, args: str = "{}") -> ToolCall:
    return ToolCall(id=tool_id, function=ToolCallFunction(name=name, arguments=args))


class _AskTool:
    def __init__(self) -> None:
        self.executed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="ask_user",
            description="stub",
            parameters={"type": "object", "properties": {}},
            face=ToolFace.ORCHESTRATION,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.executed = True
        return ToolResult(tool_call_id="", success=True, output="", effect=ToolEffect.SUSPEND)


class _OkTool:
    def __init__(self, name: str = "ok") -> None:
        self._name = name
        self.executed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            face=ToolFace.SEARCH,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.executed = True
        return ToolResult(tool_call_id="", success=True, output="done")


def test_exclusive_violation_shape():
    assert exclusive_ask_user_violation([]) is False
    assert exclusive_ask_user_violation([_call("a", "ask_user")]) is False
    assert exclusive_ask_user_violation([_call("a", "ok")]) is False
    assert exclusive_ask_user_violation([_call("a", "ask_user"), _call("b", "ok")]) is False
    assert exclusive_ask_user_violation([_call("a", "ask_user"), _call("b", "ask_user")]) is True
    assert exclusive_ask_user_violation(
        [_call("a", "ask_user</longcat_arg_key>"), _call("b", "ask_user")]
    ) is True


@pytest.mark.asyncio
async def test_mixed_batch_runs_others_then_pauses():
    order: list[str] = []

    class _OrderedAsk(_AskTool):
        async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
            order.append("ask")
            return await super().execute(arguments, context)

    class _OrderedOk(_OkTool):
        async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
            order.append("ok")
            return await super().execute(arguments, context)

    ask = _OrderedAsk()
    ok = _OrderedOk()
    reg = ToolRegistry()
    reg.register(ask)
    reg.register(ok)
    sink = EventSink()
    fact_log = TurnFactLog()
    token = current_fact_log.set(fact_log)
    try:
        messages, terminal, attempts = await execute_tools(
            [_call("a", "ask_user"), _call("b", "ok")],
            reg,
            _ctx(),
            sink,
            approval_gate=None,
            run_id="r1",
        )
        facts = [e for e in fact_log.entries() if (e.get("kind") or "") == FactKind.TOOL_CALL.value]
    finally:
        current_fact_log.reset(token)
    assert terminal is not None and terminal.effect is ToolEffect.SUSPEND
    assert ask.executed is True
    assert ok.executed is True
    assert order == ["ok", "ask"]
    assert [a.success for a in attempts] == [True, True]
    assert all("ask_user" not in (m.content or "") for m in messages)
    assert {((f.get("payload") or {}).get("tool_call_id")) for f in facts} == {"b"}


@pytest.mark.asyncio
async def test_two_asks_do_not_pause():
    ask = _AskTool()
    reg = ToolRegistry()
    reg.register(ask)
    messages, terminal, attempts = await execute_tools(
        [_call("a", "ask_user"), _call("b", "ask_user")],
        reg,
        _ctx(),
        EventSink(),
        approval_gate=None,
        run_id="r1",
    )
    assert terminal is None
    assert ask.executed is False
    assert len(attempts) == 2
    assert all(a.parse_failure for a in attempts)
    assert all(ASK_USER_NOT_EXCLUSIVE_MSG in (m.content or "") for m in messages)


@pytest.mark.asyncio
async def test_dirty_ask_name_with_other_tool_still_pauses():
    ask = _AskTool()
    ok = _OkTool()
    reg = ToolRegistry()
    reg.register(ask)
    reg.register(ok)
    messages, terminal, attempts = await execute_tools(
        [_call("a", "ask_user</longcat_arg_key>"), _call("b", "ok")],
        reg,
        _ctx(),
        EventSink(),
        approval_gate=None,
        run_id="r1",
    )
    assert terminal is not None and terminal.effect is ToolEffect.SUSPEND
    assert ask.executed is True
    assert ok.executed is True
    assert all(a.success for a in attempts)
    assert len(messages) == 1
