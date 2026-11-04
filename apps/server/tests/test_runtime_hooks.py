"""Opt-in 生命周期钩子（生成 / 最后修订 2026-11-04）。

最重要的三条：默认关时零开销、pre 的 allow **不能**绕过审批闸、
钩子失败一律 fail-open（只有明确 deny 才拒）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest
from structlog.testing import capture_logs

from agentcore.config import settings
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.llm.provider.protocol import ToolCall, ToolCallFunction
from agentcore.runtime.approvals import ApprovalDecision
from agentcore.runtime.engine.tool_exec import execute_tools
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.hooks import (
    HOOK_CAPABILITIES,
    drain_post_hooks,
    run_pre_tool_hooks,
    schedule_post_tool_hooks,
    tool_hook_payload,
)
from agentcore.runtime.hooks.runner import parse_hook_spec
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

_PY = sys.executable
_DENY_CMD = (
    "import sys,json; json.load(sys.stdin); "
    'print(json.dumps({"decision":"deny","reason":"blocked by guard"}))'
)
_ALLOW_CMD = (
    "import sys,json; json.load(sys.stdin); "
    'print(json.dumps({"decision":"allow"}))'
)
_EXIT2_CMD = "import sys,json; json.load(sys.stdin); sys.exit(2)"
_PLAIN_CMD = "import sys,json; json.load(sys.stdin); print('plain text')"
_SLEEP_CMD = "import time,sys,json; json.load(sys.stdin); time.sleep(10)"


def _spec(*hooks: dict[str, Any]) -> str:
    return json.dumps(list(hooks))


def _pre_hook(command: str = _DENY_CMD, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "event": "pre_tool_use",
        "matcher": ".*",
        "command": [_PY, "-c", command],
    }
    base.update(overrides)
    return base


def _payload(tool_name: str = "write", **extra: Any) -> dict[str, Any]:
    payload = {
        "event": "pre_tool_use",
        "tool_name": tool_name,
        "tool_input": {"file_path": "/tmp/x"},
        "tool_call_id": "c1",
        "run_id": "r1",
        "conversation_id": "conv1",
        "user_id": "u1",
        "agent_id": "a1",
    }
    payload.update(extra)
    return payload


@pytest.fixture
def hooks_env(monkeypatch):
    monkeypatch.setattr(settings, "runtime_hooks_enabled", True)
    monkeypatch.setattr(settings, "runtime_hooks_default_timeout_seconds", 5.0)
    monkeypatch.setattr(settings, "runtime_hooks_spec", "")
    return monkeypatch


# --- 配置解析 -----------------------------------------------------------------


class TestParseHookSpec:
    def test_empty_and_broken_shapes_fail_closed(self):
        assert parse_hook_spec("") == ()
        assert parse_hook_spec("not-json") == ()
        assert parse_hook_spec("{}") == ()
        assert parse_hook_spec("[]") == ()

    def test_valid_spec_keeps_matcher_and_clamps_timeout(self):
        specs = parse_hook_spec(
            _spec(
                _pre_hook(matcher="^write$", timeout_seconds=999),
                {
                    "event": "post_tool_use",
                    "matcher": ".*",
                    "command": [_PY, "-c", _ALLOW_CMD],
                },
            )
        )
        assert len(specs) == 2
        assert specs[0].matcher.pattern == "^write$"
        assert specs[0].timeout_seconds == 30.0
        assert specs[1].event == "post_tool_use"

    def test_bad_entries_are_dropped(self):
        specs = parse_hook_spec(
            _spec(
                _pre_hook(),
                {**_pre_hook(), "event": "unknown_event"},
                {**_pre_hook(), "matcher": "[unclosed"},
                {**_pre_hook(), "command": "not-a-list"},
                {**_pre_hook(), "command": [_PY, "-c", "print(1)\n"]},
                {**_pre_hook(), "command": []},
            )
        )
        assert len(specs) == 1


class TestRunnerDecisions:
    async def test_default_off_does_not_spawn_anything(self, monkeypatch):
        monkeypatch.setattr(settings, "runtime_hooks_enabled", False)
        monkeypatch.setattr(settings, "runtime_hooks_spec", _spec(_pre_hook()))
        with capture_logs() as caps:
            verdict = await run_pre_tool_hooks(tool_name="write", payload=_payload())
        assert verdict is None
        assert not [c for c in caps if str(c.get("event")).startswith("hook.")]

    async def test_explicit_deny_json_returns_reason(self, hooks_env):
        hooks_env.setattr(settings, "runtime_hooks_spec", _spec(_pre_hook()))
        with capture_logs() as caps:
            verdict = await run_pre_tool_hooks(tool_name="write", payload=_payload())
        assert verdict is not None
        assert verdict.decision == "deny"
        assert verdict.reason == "blocked by guard"
        assert any(c.get("event") == "hook.denied" for c in caps)
        assert any(c.get("event") == "hook.invoked" for c in caps)

    async def test_exit_code_2_denies_without_json(self, hooks_env):
        hooks_env.setattr(
            settings, "runtime_hooks_spec", _spec(_pre_hook(_EXIT2_CMD))
        )
        verdict = await run_pre_tool_hooks(tool_name="write", payload=_payload())
        assert verdict is not None
        assert verdict.reason == "hook denied the tool call"

    async def test_allow_and_plain_text_are_ignored(self, hooks_env):
        for cmd in (_ALLOW_CMD, _PLAIN_CMD):
            hooks_env.setattr(
                settings, "runtime_hooks_spec", _spec(_pre_hook(cmd))
            )
            assert await run_pre_tool_hooks(tool_name="write", payload=_payload()) is None

    async def test_timeout_fails_open_and_logs(self, hooks_env):
        hooks_env.setattr(
            settings,
            "runtime_hooks_spec",
            _spec(_pre_hook(_SLEEP_CMD, timeout_seconds=1)),
        )
        with capture_logs() as caps:
            verdict = await run_pre_tool_hooks(tool_name="write", payload=_payload())
        assert verdict is None
        hit = next(c for c in caps if c.get("event") == "hook.failed")
        assert hit["reason"] == "timeout"
        assert hit["hook_event"] == "pre_tool_use"

    async def test_spawn_failure_fails_open(self, hooks_env):
        hooks_env.setattr(
            settings,
            "runtime_hooks_spec",
            _spec(_pre_hook() | {"command": ["/no/such/binary"]}),
        )
        with capture_logs() as caps:
            verdict = await run_pre_tool_hooks(tool_name="write", payload=_payload())
        assert verdict is None
        assert any(c.get("reason") == "spawn_failed" for c in caps)

    async def test_matcher_only_runs_on_matching_tools(self, hooks_env):
        hooks_env.setattr(
            settings, "runtime_hooks_spec", _spec(_pre_hook(matcher="^read$"))
        )
        assert await run_pre_tool_hooks(tool_name="write", payload=_payload()) is None
        assert (
            await run_pre_tool_hooks(tool_name="read", payload=_payload("read"))
            is not None
        )

    async def test_hook_receives_the_payload_on_stdin(self, hooks_env, tmp_path):
        out = tmp_path / "payload.json"
        cmd = (
            "import sys,json,pathlib; "
            "pathlib.Path(sys.argv[1]).write_text(sys.stdin.read()); "
            'print(json.dumps({"decision":"allow"}))'
        )
        hooks_env.setattr(
            settings,
            "runtime_hooks_spec",
            _spec(_pre_hook(cmd) | {"command": [_PY, "-c", cmd, str(out)]}),
        )
        await run_pre_tool_hooks(tool_name="write", payload=_payload())
        received = json.loads(out.read_text())
        assert received["tool_name"] == "write"
        assert received["tool_input"] == {"file_path": "/tmp/x"}
        assert received["run_id"] == "r1"

    async def test_post_hook_is_fire_and_forget_and_observable(self, hooks_env):
        hooks_env.setattr(
            settings,
            "runtime_hooks_spec",
            _spec({"event": "post_tool_use", "matcher": ".*", "command": [_PY, "-c", _ALLOW_CMD]}),
        )
        with capture_logs() as caps:
            schedule_post_tool_hooks(tool_name="write", payload=_payload(success=True))
            await drain_post_hooks()
        assert any(
            c.get("event") == "hook.invoked" and c.get("hook_event") == "post_tool_use"
            for c in caps
        )

    def test_huge_payload_is_truncated(self):
        payload = tool_hook_payload(
            event="pre_tool_use",
            tool_name="write",
            args={"blob": "x" * 200_000},
            tc_id="c1",
            context=object(),
        )
        assert payload["tool_input"] == {"_truncated": True, "reason": "payload_too_large"}

    def test_capabilities_do_not_overclaim(self):
        assert HOOK_CAPABILITIES["enabled_by_default"] is False
        assert HOOK_CAPABILITIES["pre_hook_allow_can_bypass_approval"] is False
        assert HOOK_CAPABILITIES["post_hook_can_modify_result"] is False
        assert HOOK_CAPABILITIES["user_configurable_commands"] is False


# --- 引擎接线（真实 execute_tools）---------------------------------------------


def _ctx() -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


class _Stub:
    def __init__(self, name: str = "write", approval: ToolApproval = ToolApproval.NEVER):
        self._name = name
        self._approval = approval
        self.executed = False

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub",
            parameters={"type": "object", "properties": {}},
            face=ToolFace.SEARCH,
            approval=self._approval,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        self.executed = True
        return ToolResult(tool_call_id="", success=True, output="ok")


class _DenyingGate:
    permission_axes = None
    file_op_tools: frozenset[str] = frozenset()

    def will_prompt(self, **_kwargs: Any) -> bool:
        return True

    async def authorize(self, **_kwargs: Any) -> ApprovalDecision:
        return ApprovalDecision.DENY


def _call() -> ToolCall:
    return ToolCall(id="c1", function=ToolCallFunction(name="write", arguments="{}"))


def _registry(tool: Any) -> ToolRegistry:
    reg = ToolRegistry()
    reg.register(tool)
    return reg


def _end(sink: EventSink) -> dict[str, Any]:
    ends = [e for e in sink._history if e.type == EventType.TOOL_USE_END]  # noqa: SLF001
    assert len(ends) == 1
    return ends[0].payload


class TestEngineWiring:
    async def test_default_off_leaves_tool_execution_untouched(self, monkeypatch):
        monkeypatch.setattr(settings, "runtime_hooks_enabled", False)
        tool = _Stub()
        sink = EventSink()
        _messages, _terminal, attempts = await execute_tools(
            [_call()], _registry(tool), _ctx(), sink,
            approval_gate=None, run_id="r1",
        )
        assert tool.executed is True
        assert attempts[0].policy_failure is False

    async def test_pre_deny_prevents_execution_and_marks_policy_failure(self, hooks_env):
        hooks_env.setattr(settings, "runtime_hooks_spec", _spec(_pre_hook()))
        tool = _Stub()
        sink = EventSink()
        _messages, _terminal, attempts = await execute_tools(
            [_call()], _registry(tool), _ctx(), sink,
            approval_gate=None, run_id="r1",
        )
        assert tool.executed is False
        assert attempts[0].policy_failure is True
        assert "blocked by guard" in (_end(sink).get("result") or "")

    async def test_pre_allow_does_not_bypass_the_approval_gate(self, hooks_env):
        """allow 必须被忽略：审批闸仍然拒绝，工具不能被执行。"""
        hooks_env.setattr(
            settings, "runtime_hooks_spec", _spec(_pre_hook(_ALLOW_CMD))
        )
        tool = _Stub(approval=ToolApproval.GRANTABLE)
        sink = EventSink()
        with capture_logs() as caps:
            _messages, _terminal, attempts = await execute_tools(
                [_call()], _registry(tool), _ctx(), sink,
                approval_gate=_DenyingGate(), run_id="r1",  # type: ignore[arg-type]
            )
        assert tool.executed is False
        assert attempts[0].policy_failure is True
        assert not any(c.get("event") == "hook.denied" for c in caps)

    async def test_post_hook_does_not_change_the_tool_result(self, hooks_env):
        hooks_env.setattr(
            settings,
            "runtime_hooks_spec",
            _spec({"event": "post_tool_use", "matcher": ".*", "command": [_PY, "-c", _DENY_CMD]}),
        )
        tool = _Stub()
        sink = EventSink()
        _messages, _terminal, attempts = await execute_tools(
            [_call()], _registry(tool), _ctx(), sink,
            approval_gate=None, run_id="r1",
        )
        await drain_post_hooks()
        # post 里就算喊 deny 也只观测：结果仍是成功执行。
        assert tool.executed is True
        assert attempts[0].success is True
        assert _end(sink)["status"] != "error"
