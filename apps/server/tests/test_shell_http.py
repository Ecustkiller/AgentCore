"""Public curl/wget stay on ``run`` (no dedicated download tool; no channel redirect)."""

from __future__ import annotations

from pathlib import Path

from agentcore.tools.builtin.run import RunTool
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult


class _FakeShortBackend:
    location = "server"

    def __init__(self) -> None:
        self.requests: list[ExecutionRequest] = []

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.requests.append(request)
        return ExecutionResult(
            success=True, stdout="ok\n", stderr="", exit_code=0, duration_ms=1
        )


def _ctx(backend: _FakeShortBackend) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="worker",
        backend=backend,  # type: ignore[arg-type]
        user_id="u",
    )


async def test_run_executes_bare_public_curl():
    backend = _FakeShortBackend()
    result = await RunTool().execute(
        {"command": "curl -sS https://example.com/pay"},
        _ctx(backend),
    )
    assert result.success is True
    assert result.failure_code is None
    assert len(backend.requests) == 1


async def test_run_executes_wget_to_file():
    backend = _FakeShortBackend()
    result = await RunTool().execute(
        {"command": "wget https://example.com/a.bin"},
        _ctx(backend),
    )
    assert result.success is True
    assert len(backend.requests) == 1


async def test_run_still_executes_curl_in_a_pipeline():
    backend = _FakeShortBackend()
    result = await RunTool().execute(
        {"command": "curl https://example.com | wc -c"},
        _ctx(backend),
    )
    assert result.success is True
    assert len(backend.requests) == 1


def test_public_http_clients_disable_tls_verify():
    """Lock: the public door stays as capable as curl -k; do not re-enable verify."""
    path = (
        Path(__file__).resolve().parents[1]
        / "agentcore"
        / "tools"
        / "builtin"
        / "web"
        / "web_fetch.py"
    )
    text = path.read_text(encoding="utf-8")
    assert "PinnedIPTransport(verify=False)" in text
