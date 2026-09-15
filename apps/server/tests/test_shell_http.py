"""Entire-command curl/wget is a wrong HTTP channel, not a script classifier."""

from __future__ import annotations

from pathlib import Path

from agentcore.runtime.engine.tool_channel_redirect import is_channel_redirect_code
from agentcore.tools.builtin.run import RunTool
from agentcore.tools.builtin.shell_http import (
    SHELL_DOWNLOAD_REDIRECT,
    SHELL_FETCH_REDIRECT,
    shell_http_match,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.protocol import ExecutionRequest, ExecutionResult


def test_bare_curl_is_web_fetch():
    hit = shell_http_match("curl -sS https://example.com/pay")
    assert hit is not None
    assert hit.dest == "web_fetch"
    assert hit.code == SHELL_FETCH_REDIRECT
    assert hit.url == "https://example.com/pay"


def test_wget_default_is_download():
    hit = shell_http_match("wget https://example.com/a.bin")
    assert hit is not None
    assert hit.dest == "download_url"
    assert hit.code == SHELL_DOWNLOAD_REDIRECT


def test_curl_output_file_is_download():
    hit = shell_http_match("curl -o pay.html https://example.com/pay")
    assert hit is not None
    assert hit.dest == "download_url"


def test_curl_stdout_redirect_is_download():
    hit = shell_http_match("curl https://example.com/pay > pay.html")
    assert hit is not None
    assert hit.dest == "download_url"


def test_wget_stdout_is_fetch():
    hit = shell_http_match("wget -qO- https://example.com/pay")
    assert hit is not None
    assert hit.dest == "web_fetch"


def test_leading_env_and_stderr_merge_still_match():
    hit = shell_http_match("FOO=1 curl -sS https://example.com/a 2>&1")
    assert hit is not None
    assert hit.dest == "web_fetch"


def test_pipes_and_and_are_not_the_whole_command():
    assert shell_http_match("curl https://example.com | jq .") is None
    assert shell_http_match("curl https://example.com && echo hi") is None
    assert shell_http_match("cd /tmp && curl https://example.com") is None
    assert shell_http_match("curl https://example.com && pnpm test") is None


def test_post_and_unknown_flags_do_not_match():
    assert shell_http_match("curl -X POST https://example.com") is None
    assert shell_http_match("curl --data @body https://example.com") is None
    assert shell_http_match("curl -H 'Accept: x' https://example.com") is None


def test_loopback_and_private_stay_on_run():
    assert shell_http_match("curl -sS http://127.0.0.1:3000/api") is None
    assert shell_http_match("curl http://localhost/health") is None
    assert shell_http_match("curl http://192.168.1.8/x") is None
    assert shell_http_match("curl http://printer.local/status") is None


def test_install_and_python_are_untouched():
    assert shell_http_match("npm install") is None
    assert shell_http_match("python -c 'import urllib.request'") is None
    assert shell_http_match("echo https://example.com") is None


def test_two_urls_do_not_match():
    assert (
        shell_http_match("curl https://example.com/a https://example.com/b") is None
    )


class _FakeShortBackend:
    location = "server"

    def __init__(self) -> None:
        self.requests: list[ExecutionRequest] = []

    async def execute(self, request: ExecutionRequest) -> ExecutionResult:
        self.requests.append(request)
        return ExecutionResult(
            success=True, stdout="should-not-run\n", stderr="", exit_code=0, duration_ms=1
        )


def _ctx(backend: _FakeShortBackend) -> ToolContext:
    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="worker",
        backend=backend,  # type: ignore[arg-type]
        user_id="u",
    )


async def test_run_redirects_bare_curl_without_executing():
    backend = _FakeShortBackend()
    result = await RunTool().execute(
        {"command": "curl -sS https://example.com/pay"},
        _ctx(backend),
    )
    assert result.success is False
    assert result.contract_failure is True
    assert result.failure_code == SHELL_FETCH_REDIRECT
    assert result.metadata is not None
    assert result.metadata["code"] == SHELL_FETCH_REDIRECT
    assert is_channel_redirect_code(result.failure_code)
    err = result.error or ""
    assert "web_fetch" in err
    assert "download_url" in err
    assert "禁止" not in err
    from agentcore.runtime.engine.tool_failure_face import tool_failure_from_result

    assert tool_failure_from_result(result) == {"code": SHELL_FETCH_REDIRECT}
    assert backend.requests == []


async def test_run_redirects_wget_to_download_url():
    backend = _FakeShortBackend()
    result = await RunTool().execute(
        {"command": "wget https://example.com/a.bin"},
        _ctx(backend),
    )
    assert result.failure_code == SHELL_DOWNLOAD_REDIRECT
    assert "download_url" in (result.error or "")
    assert backend.requests == []


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
    root = (
        Path(__file__).resolve().parents[1]
        / "agentcore"
        / "tools"
        / "builtin"
        / "web"
    )
    for name in ("web_fetch.py", "download_url.py"):
        text = (root / name).read_text(encoding="utf-8")
        assert "PinnedIPTransport(verify=False)" in text, name
