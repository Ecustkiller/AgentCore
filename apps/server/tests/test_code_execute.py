"""Tests for the code_execute tool's structured display (工具结果富渲染).

The tool flattens stdout/stderr/exit_code into the model-facing ``output`` string,
but also carries them STRUCTURED on ``display`` so the desktop renders a terminal
view (stderr in red, exit-code badge) instead of parsing "stdout:\\n…" text. A
non-zero exit must still produce a display (so a failed run surfaces its stderr).
"""

from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult


class _FakeBackend:
    """A workspace backend stub whose ``execute`` returns a canned result."""

    def __init__(self, result: ExecutionResult) -> None:
        self._result = result
        self.requests: list[ExecutionRequest] = []

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.requests.append(request)
        return self._result


def _ctx(backend: _FakeBackend) -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=backend,  # type: ignore[arg-type]
        user_id="u",
    )


async def test_code_execute_display_carries_stdout_and_exit():
    backend = _FakeBackend(
        ExecutionResult(success=True, stdout="hello\n", stderr="", exit_code=0, duration_ms=5)
    )
    result = await CodeExecuteTool().execute(
        {"code": "print('hello')", "language": "python"}, _ctx(backend)
    )

    assert result.success is True
    assert result.display == {
        "stdout": "hello\n",
        "stderr": "",
        "exit_code": 0,
        "language": "python",
    }


async def test_code_execute_display_on_failure_keeps_stderr_and_exit():
    backend = _FakeBackend(
        ExecutionResult(
            success=False,
            stdout="",
            stderr="Traceback (most recent call last):\nNameError: name 'boom'",
            exit_code=1,
            duration_ms=5,
        )
    )
    result = await CodeExecuteTool().execute({"code": "boom", "language": "python"}, _ctx(backend))

    assert result.success is False
    assert result.display is not None
    assert result.display["exit_code"] == 1
    assert "NameError" in result.display["stderr"]
    assert result.display["language"] == "python"
