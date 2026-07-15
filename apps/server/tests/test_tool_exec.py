"""Tests for parallel tool execution and per-tool exception firewall (audit/05 P2-1)."""

from pathlib import Path
from typing import Any

import pytest

from agentcore.core.errors import SandboxError
from agentcore.core.types import ToolCategory, ToolEffect
from agentcore.llm.provider.protocol import ToolCall, ToolCallFunction
from agentcore.runtime.engine.tool_exec import execute_tools
from agentcore.runtime.events import EventSink, EventType
from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.builtin.test_run import TestRunTool
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(backend=None) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=backend
        or ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _call(tool_id: str, name: str, args: str = "{}") -> ToolCall:
    return ToolCall(id=tool_id, function=ToolCallFunction(name=name, arguments=args))


class _OkTool:
    def __init__(self, name: str = "ok", *, output: str = "done") -> None:
        self._name = name
        self._output = output
        self.executed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.executed = True
        return ToolResult(tool_call_id="", success=True, output=self._output)


class _CrashTool:
    def __init__(self, name: str = "crash") -> None:
        self._name = name
        self.executed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.executed = True
        raise SandboxError("sandbox blew up")


class _SuspendTool:
    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="ask",
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.INTERACTION,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        return ToolResult(
            tool_call_id="",
            success=True,
            output="waiting",
            effect=ToolEffect.SUSPEND,
        )


class _HandoffTool:
    def __init__(self, name: str = "handoff") -> None:
        self._name = name

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.ORCHESTRATION,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        return ToolResult(
            tool_call_id="",
            success=True,
            output="done",
            effect=ToolEffect.HANDOFF,
            final_text="handoff answer",
        )


class _FakeBackend:
    def __init__(self, *, raise_sandbox: bool = False) -> None:
        self._raise_sandbox = raise_sandbox
        self.requests: list[ExecutionRequest] = []

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.requests.append(request)
        if self._raise_sandbox:
            raise SandboxError("代码执行环境启动失败：interpreter missing")
        return ExecutionResult(success=True, stdout="ok\n", stderr="", exit_code=0, duration_ms=1)

    async def read(self, path: str) -> bytes:
        raise FileNotFoundError(path)

    async def index_files(self, *, cap: int = 50, order: str = "recent"):
        return [], 0


@pytest.fixture
def registry() -> tuple[ToolRegistry, _OkTool]:
    ok_b = _OkTool("ok_b", output="beta")
    reg = ToolRegistry()
    reg.register(_OkTool("ok_a", output="alpha"))
    reg.register(ok_b)
    reg.register(_CrashTool())
    reg.register(_SuspendTool())
    return reg, ok_b


async def test_parallel_crash_does_not_cancel_sibling(registry: tuple[ToolRegistry, _OkTool]):
    reg, ok_b = registry
    sink = EventSink()
    messages, terminal, attempts = await execute_tools(
        [_call("c1", "crash"), _call("c2", "ok_b")],
        reg,
        _ctx(),
        sink,
        run_id="r1",
    )

    assert ok_b.executed is True
    assert terminal is None
    assert len(messages) == 2
    assert len(attempts) == 2
    assert attempts[0].success is False
    assert attempts[1].success is True
    crash_msg = next(m for m in messages if m.tool_call_id == "c1")
    ok_msg = next(m for m in messages if m.tool_call_id == "c2")
    assert "内部错误" in (crash_msg.content or "")
    assert ok_msg.content == "beta"


async def test_crash_emits_failed_tool_use_end(registry: tuple[ToolRegistry, _OkTool]):
    reg, _ok_b = registry
    sink = EventSink()
    await execute_tools([_call("c1", "crash")], reg, _ctx(), sink, run_id="r1")

    ends = [e for e in sink._history if e.type == EventType.TOOL_USE_END]  # noqa: SLF001
    assert len(ends) == 1
    assert ends[0].payload["status"] == "error"
    assert "内部错误" in (ends[0].payload.get("result") or "")


async def test_suspend_terminal_unchanged(registry: tuple[ToolRegistry, _OkTool]):
    reg, _ok_b = registry
    sink = EventSink()
    messages, terminal, attempts = await execute_tools(
        [_call("c1", "ask")],
        reg,
        _ctx(),
        sink,
        run_id="r1",
    )

    assert terminal is not None
    assert terminal.effect is ToolEffect.SUSPEND
    assert messages == []
    assert len(attempts) == 1
    assert attempts[0].success is True
    # SUSPEND skips durable tool_use_end (挂起即收口) — live UI has *_required already.
    ends = [e for e in sink._history if e.type == EventType.TOOL_USE_END]  # noqa: SLF001
    assert ends == []
    starts = [e for e in sink._history if e.type == EventType.TOOL_USE_START]  # noqa: SLF001
    assert len(starts) == 1


async def test_multi_terminal_prefers_suspend():
    # Defense (audit F6): when a round somehow yields both HANDOFF and SUSPEND,
    # SUSPEND wins (durable pause must not lose to call-order luck). Normal agent
    # toolsets never hold both; this guards the unreachable race.
    reg = ToolRegistry()
    reg.register(_HandoffTool())
    reg.register(_SuspendTool())
    sink = EventSink()
    # HANDOFF listed first — old "first terminal wins" would pick HANDOFF.
    _messages, terminal, _attempts = await execute_tools(
        [_call("c1", "handoff"), _call("c2", "ask")],
        reg,
        _ctx(),
        sink,
        run_id="r1",
    )
    assert terminal is not None
    assert terminal.effect is ToolEffect.SUSPEND


async def test_code_execute_maps_sandbox_error_to_failed_result():
    backend = _FakeBackend(raise_sandbox=True)
    result = await CodeExecuteTool().execute(
        {"code": "print(1)", "language": "python"},
        _ctx(backend),  # type: ignore[arg-type]
    )

    assert result.success is False
    assert "代码执行环境启动失败" in (result.error or "")


async def test_test_run_maps_sandbox_error_to_failed_result(monkeypatch: pytest.MonkeyPatch):
    backend = _FakeBackend(raise_sandbox=True)

    async def _profile(_backend):
        from agentcore.runtime.context.workspace_profile import WorkspaceProfile

        return WorkspaceProfile(
            languages=["python"],
            frameworks=[],
            package_managers=[],
            test_commands=["pytest"],
        )

    async def _framework(_backend, _profile, _arg):
        return "pytest"

    monkeypatch.setattr(
        "agentcore.tools.builtin.test_run.detect_workspace_profile",
        _profile,
    )
    monkeypatch.setattr(
        "agentcore.tools.builtin.test_run._detect_framework",
        _framework,
    )

    result = await TestRunTool().execute({"scope": "all"}, _ctx(backend))  # type: ignore[arg-type]

    assert result.success is False
    assert "代码执行环境启动失败" in (result.error or "")
