"""ServerWorkspace once-per-backend exec-env probe."""

from __future__ import annotations

from pathlib import Path

import pytest

from agentcore.tools.sandbox.exec_env import (
    EXEC_ENV_PROBE_FAIL_MARKER,
    is_exec_env_probe_failure,
)
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult
from agentcore.workspace.server import ServerWorkspace


class _FakeSandbox:
    def __init__(self, *, health_ok: bool = True) -> None:
        self.health_ok = health_ok
        self.health_calls = 0
        self.execute_calls = 0

    async def health_check(self) -> bool:
        self.health_calls += 1
        return self.health_ok

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.execute_calls += 1
        return ExecutionResult(
            success=True,
            stdout="hi",
            stderr="",
            exit_code=0,
            duration_ms=1,
        )


@pytest.mark.anyio
async def test_server_workspace_probe_pass_then_execute(tmp_path: Path):
    sandbox = _FakeSandbox(health_ok=True)
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    assert result.success is True
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 1
    # Second call skips probe.
    await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=5)
    )
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 2


@pytest.mark.anyio
async def test_server_workspace_probe_fail_blocks_execute(tmp_path: Path):
    sandbox = _FakeSandbox(health_ok=False)
    ws = ServerWorkspace(root=tmp_path, sandbox=sandbox, location="local")
    result = await ws.execute(
        ExecutionRequest(code="print(1)", language="python", timeout_seconds=5)
    )
    assert result.success is False
    assert is_exec_env_probe_failure(result.stderr)
    assert EXEC_ENV_PROBE_FAIL_MARKER in result.stderr
    assert sandbox.execute_calls == 0
    # Sticky fail-fast without re-probing.
    again = await ws.execute(
        ExecutionRequest(code="print(2)", language="python", timeout_seconds=5)
    )
    assert again.success is False
    assert sandbox.health_calls == 1
    assert sandbox.execute_calls == 0
