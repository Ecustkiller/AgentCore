"""Tests for the web tools (search backend, SSRF guard, extraction, breaker).

Pure logic + offline paths only — no real network. SSRF rejection is verified by
calling ``read_url`` against private/blocked hosts (classification short-circuits
before any request), and search parsing is tested via the pure ``_parse_results``.
"""

from pathlib import Path

import httpx
import pytest

from agentcore.tools.builtin.web import _net
from agentcore.tools.builtin.web._net import (
    EgressError,
    circuit_remaining,
    describe_net_error,
    note_failure,
    note_success,
)
from agentcore.tools.builtin.web.read_url import (
    ReadUrlTool,
    _classify_url,
    _extract_text,
    _ip_is_safe,
    _URLBlock,
)
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.builtin.web.search_backend import _parse_results
from agentcore.tools.protocol import ToolContext, ToolResult


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        step_id="s",
        agent_id="a",
        workspace_dir=Path("."),
        user_id="u",
    )


# --- search_backend._parse_results ---


def test_parse_results_maps_fields_and_caps():
    data = {
        "results": [
            {"title": "A", "url": "https://a.com", "content": "snip a"},
            {"title": "B", "url": "https://b.com", "content": "snip b"},
            {"title": "C", "url": "https://c.com", "content": "snip c"},
        ]
    }
    out = _parse_results(data, max_results=2)
    assert len(out) == 2
    assert out[0].title == "A"
    assert out[0].url == "https://a.com"
    assert out[0].snippet == "snip a"


def test_parse_results_dedups_normalized_url():
    data = {
        "results": [
            {"title": "A", "url": "https://a.com/page", "content": "1"},
            {"title": "A dup", "url": "https://a.com/page/#section", "content": "2"},
            {"title": "B", "url": "https://b.com", "content": "3"},
        ]
    }
    out = _parse_results(data, max_results=10)
    assert [r.url for r in out] == ["https://a.com/page", "https://b.com"]


def test_parse_results_skips_incomplete_entries():
    data = {
        "results": [
            {"title": "", "url": "https://a.com", "content": "x"},
            {"title": "B", "url": "", "content": "y"},
            {"title": "C", "url": "https://c.com", "content": None},
        ]
    }
    out = _parse_results(data, max_results=10)
    assert len(out) == 1
    assert out[0].url == "https://c.com"
    assert out[0].snippet == ""


# --- _net: circuit breaker + error description ---


def test_circuit_breaker_trips_after_threshold():
    host = "breaker-test.example"
    _net._states.pop(host, None)
    for _ in range(_net.WEB_HOST_FAIL_THRESHOLD - 1):
        note_failure(host)
    assert circuit_remaining(host) == 0.0
    note_failure(host)  # threshold hit
    assert circuit_remaining(host) > 0.0
    note_success(host)
    assert circuit_remaining(host) == 0.0


def test_describe_net_error_is_honest():
    assert "连接超时" in describe_net_error(httpx.ConnectTimeout(""))
    assert "读取超时" in describe_net_error(httpx.ReadTimeout(""))
    assert describe_net_error(EgressError("已熔断")) == "已熔断"

    req = httpx.Request("GET", "https://x.com")
    err = httpx.HTTPStatusError("boom", request=req, response=httpx.Response(403, request=req))
    assert describe_net_error(err) == "HTTP 403"


# --- read_url: SSRF classification ---


def test_ip_is_safe_blocks_private_and_metadata():
    assert _ip_is_safe("1.1.1.1") is True
    assert _ip_is_safe("8.8.8.8") is True
    assert _ip_is_safe("127.0.0.1") is False
    assert _ip_is_safe("10.0.0.1") is False
    assert _ip_is_safe("192.168.1.1") is False
    assert _ip_is_safe("169.254.169.254") is False  # cloud metadata
    assert _ip_is_safe("not-an-ip") is False


async def test_classify_url_bad_scheme():
    assert await _classify_url("ftp://example.com") is _URLBlock.BAD_SCHEME
    assert await _classify_url("file:///etc/passwd") is _URLBlock.BAD_SCHEME


async def test_classify_url_blocked_hosts():
    assert await _classify_url("http://localhost/x") is _URLBlock.BLOCKED_HOST
    assert await _classify_url("http://foo.internal/") is _URLBlock.BLOCKED_HOST
    assert await _classify_url("http://db.local/") is _URLBlock.BLOCKED_HOST


async def test_classify_url_literal_private_ip():
    assert await _classify_url("http://127.0.0.1:8000/") is _URLBlock.PRIVATE_IP
    assert await _classify_url("http://169.254.169.254/latest/") is _URLBlock.PRIVATE_IP
    assert await _classify_url("http://10.1.2.3/") is _URLBlock.PRIVATE_IP


async def test_classify_url_public_literal_ip_ok():
    assert await _classify_url("https://1.1.1.1/") is None


# --- read_url: HTML extraction ---


def test_extract_text_strips_scripts_and_keeps_title():
    html = (
        "<html><head><title>Hello</title>"
        "<style>.x{color:red}</style></head>"
        "<body><script>var a=1;</script>"
        "<p>First para</p><p>Second para</p></body></html>"
    )
    title, text = _extract_text(html, max_chars=1000)
    assert title == "Hello"
    assert "var a=1" not in text
    assert "color:red" not in text
    assert "First para" in text
    assert "Second para" in text


def test_extract_text_truncates():
    html = "<body><p>" + ("x" * 500) + "</p></body>"
    _title, text = _extract_text(html, max_chars=100)
    assert len(text) == 100


# --- tool execute: offline rejection paths ---


async def test_read_url_rejects_private_without_network():
    result = await ReadUrlTool().execute({"url": "http://127.0.0.1:9999/"}, _ctx())
    assert result.success is False
    assert result.error == _URLBlock.PRIVATE_IP.value


async def test_read_url_requires_url():
    result = await ReadUrlTool().execute({}, _ctx())
    assert result.success is False
    assert "url" in result.error


async def test_web_search_requires_query():
    result = await WebSearchTool().execute({"query": "  "}, _ctx())
    assert result.success is False
    assert "query" in result.error


# --- ToolResult.output_limit ---


def test_tool_result_default_truncates_at_4000():
    r = ToolResult(tool_call_id="", success=True, output="a" * 5000)
    assert r.output.endswith("[output truncated]")
    assert len(r.output) < 5000


def test_tool_result_respects_higher_output_limit():
    body = "a" * 5000
    r = ToolResult(tool_call_id="", success=True, output=body, output_limit=8000)
    assert r.output == body


@pytest.mark.parametrize("limit", [10, 50])
def test_tool_result_custom_lower_limit(limit: int):
    r = ToolResult(tool_call_id="", success=True, output="a" * 100, output_limit=limit)
    assert r.output.startswith("a" * limit)
    assert r.output.endswith("[output truncated]")
