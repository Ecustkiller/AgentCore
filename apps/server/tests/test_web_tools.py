"""Tests for the web tools (search backend, SSRF guard, extraction, breaker).

Pure logic + offline paths only — no real network. SSRF rejection is verified by
calling ``read_url`` against private/blocked hosts (classification short-circuits
before any request), and search parsing is tested via the pure ``_parse_results``.
"""

from pathlib import Path

import httpx
import pytest

from agentcore.runtime.citations import annotate_tool_citations, merge_citations
from agentcore.tools.builtin.web import _net
from agentcore.tools.builtin.web import read_url as read_url_mod
from agentcore.tools.builtin.web import search as search_mod
from agentcore.tools.builtin.web import search_backend as search_backend_mod
from agentcore.tools.builtin.web._net import (
    EgressError,
    circuit_remaining,
    describe_net_error,
    note_failure,
    note_success,
    site_of,
)
from agentcore.tools.builtin.web.read_url import (
    ReadUrlTool,
    _classify_url,
    _extract_page,
    _extract_text,
    _ip_is_safe,
    _make_snippet,
    _URLBlock,
)
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.builtin.web.search_backend import (
    SearchResult,
    SearXNGBackend,
    _parse_results,
)
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
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


def test_extract_text_drops_nav_header_footer_chrome():
    html = (
        "<body><nav>首页 登录 注册</nav><header>站点横幅</header>"
        "<p>真正的正文段落</p>"
        "<footer>版权所有 联系我们</footer><aside>相关推荐</aside></body>"
    )
    _title, text = _extract_text(html, max_chars=1000)
    assert "真正的正文段落" in text
    assert "登录" not in text
    assert "站点横幅" not in text
    assert "版权所有" not in text
    assert "相关推荐" not in text


# --- read_url: meta description seeds citation snippet ---


def test_extract_page_reads_meta_description():
    html = (
        "<html><head><title>T</title>"
        '<meta name="description" content="  Page summary here.  ">'
        "</head><body><p>Body lead</p></body></html>"
    )
    title, text, description = _extract_page(html, max_chars=1000)
    assert title == "T"
    assert "Body lead" in text
    assert description == "Page summary here."


def test_extract_page_reads_og_and_twitter_description():
    og = '<meta property="og:description" content="OG summary">'
    assert _extract_page(f"<head>{og}</head>", 1000)[2] == "OG summary"
    tw = '<meta name="twitter:description" content="TW summary">'
    assert _extract_page(f"<head>{tw}</head>", 1000)[2] == "TW summary"


def test_extract_page_no_description_is_empty():
    html = "<html><head><title>T</title></head><body><p>x</p></body></html>"
    assert _extract_page(html, 1000)[2] == ""


def test_make_snippet_prefers_description_over_text():
    assert _make_snippet("  the meta desc ", "body text lead") == "the meta desc"


def test_make_snippet_falls_back_to_text_lead():
    assert _make_snippet("", "  body  lead   text ") == "body lead text"


def test_make_snippet_collapses_whitespace_and_caps_length():
    out = _make_snippet("word " * 100, "")  # 500 chars before collapse
    assert len(out) <= 200
    assert "  " not in out  # whitespace collapsed to single spaces


async def test_read_url_emits_citation_snippet_from_description(monkeypatch):
    html = (
        "<html><head><title>深圳天气</title>"
        '<meta name="description" content="今天多云转晴，气温 20-28 度。">'
        "</head><body><nav>导航</nav><p>正文内容</p></body></html>"
    )

    async def _allow(_url: str):
        return None

    async def _fake_request(_client, _method, url, **_kwargs):
        return httpx.Response(200, html=html, request=httpx.Request("GET", url))

    monkeypatch.setattr(read_url_mod, "_classify_url", _allow)
    monkeypatch.setattr(read_url_mod, "_safe_request", _fake_request)

    result = await ReadUrlTool().execute({"url": "https://weather.example.com/sz"}, _ctx())

    assert result.success is True
    assert result.citations is not None
    cite = result.citations[0]
    assert cite["url"] == "https://weather.example.com/sz"
    assert cite["title"] == "深圳天气"
    assert cite["site"] == "weather.example.com"
    assert cite["snippet"] == "今天多云转晴，气温 20-28 度。"


async def test_read_url_snippet_falls_back_to_body_when_no_meta(monkeypatch):
    html = "<html><head><title>无摘要页</title></head><body><p>正文第一段</p></body></html>"

    async def _allow(_url: str):
        return None

    async def _fake_request(_client, _method, url, **_kwargs):
        return httpx.Response(200, html=html, request=httpx.Request("GET", url))

    monkeypatch.setattr(read_url_mod, "_classify_url", _allow)
    monkeypatch.setattr(read_url_mod, "_safe_request", _fake_request)

    result = await ReadUrlTool().execute({"url": "https://x.example.com/a"}, _ctx())

    assert result.success is True
    assert result.citations is not None
    assert result.citations[0]["snippet"] == "正文第一段"


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


async def test_searxng_backend_trips_circuit_after_transport_failures(monkeypatch):
    host = "localhost"
    _net._states.pop(host, None)

    class _FailClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _FailClient())

    backend = SearXNGBackend("http://localhost:18888")
    for _ in range(_net.WEB_HOST_FAIL_THRESHOLD):
        with pytest.raises(httpx.ConnectError):
            await backend.search("q")

    with pytest.raises(EgressError, match="熔断"):
        await backend.search("q")


async def test_web_search_fast_fails_when_circuit_open(monkeypatch):
    host = "localhost"
    _net._states.pop(host, None)

    class _FailClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _FailClient())
    monkeypatch.setattr(search_backend_mod, "_backend", None)

    tool = WebSearchTool()
    for _ in range(_net.WEB_HOST_FAIL_THRESHOLD):
        result = await tool.execute({"query": "test"}, _ctx())
        assert result.success is False

    result = await tool.execute({"query": "test"}, _ctx())
    assert result.success is False
    assert "熔断" in result.error
    assert result.duration_ms < 500


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


# --- citations: site_of + tool wiring + cross-round dedup ---


def test_site_of_strips_www_and_lowercases():
    assert site_of("https://www.Example.com/path?q=1") == "example.com"
    assert site_of("https://news.site.cn/a") == "news.site.cn"
    assert site_of("https://1.1.1.1/x") == "1.1.1.1"
    assert site_of("not a url") == ""


async def test_web_search_emits_structured_citations(monkeypatch):
    class _FakeBackend:
        async def search(self, query, max_results=5):
            return [
                SearchResult("标题一", "https://www.example.com/a", "摘要一"),
                SearchResult("标题二", "https://b.cn/p", "摘要二"),
            ]

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _FakeBackend())
    result = await WebSearchTool().execute({"query": "深圳天气"}, _ctx())

    assert result.success is True
    assert result.citations == [
        {
            "url": "https://www.example.com/a",
            "title": "标题一",
            "snippet": "摘要一",
            "site": "example.com",
        },
        {"url": "https://b.cn/p", "title": "标题二", "snippet": "摘要二", "site": "b.cn"},
    ]


def test_merge_citations_dedups_across_rounds_by_normalized_url():
    sink: list[dict] = []
    first = merge_citations(
        sink, [{"url": "https://a.com/p", "title": "A", "site": "a.com"}]
    )
    assert first == {"https://a.com/p": 1}
    # same page (trailing slash + fragment) from a later round + a fresh source
    second = merge_citations(
        sink,
        [
            {"url": "https://a.com/p/#sec", "title": "A again", "site": "a.com"},
            {"url": "https://b.com", "title": "B", "site": "b.com"},
        ],
    )
    assert [c["url"] for c in sink] == ["https://a.com/p", "https://b.com"]
    # A2: the dup reuses source #1's number; the fresh source gets the next card
    # index — numbers stay stable across rounds so body [n] keeps pointing right.
    assert second == {"https://a.com/p": 1, "https://b.com": 2}


def test_merge_citations_skips_blank_url_and_caps():
    sink: list[dict] = []
    blank = merge_citations(sink, [{"url": "", "title": "blank"}])
    assert sink == []
    assert blank == {}  # a blank URL yields no card and no number
    numbers = merge_citations(
        sink, [{"url": f"https://s{i}.com", "title": str(i)} for i in range(50)]
    )
    assert len(sink) == 24  # _CITATION_CAP
    # only the 24 that fit the cap get a number; the rest are uncitable (no card)
    assert len(numbers) == 24
    assert numbers["https://s0.com"] == 1
    assert numbers["https://s23.com"] == 24
    assert "https://s24.com" not in numbers


def test_annotate_tool_citations_appends_assigned_numbers():
    cites = [
        {"url": "https://a.com", "title": "A"},
        {"url": "https://b.com", "title": "B"},
    ]
    numbers = {"https://a.com": 1, "https://b.com": 2}
    out = annotate_tool_citations("RESULT", cites, numbers)
    assert out.startswith("RESULT")
    assert "[来源编号]" in out
    assert "[1]=https://a.com" in out
    assert "[2]=https://b.com" in out


def test_annotate_tool_citations_omits_capped_and_dedups_by_number():
    cites = [
        {"url": "https://a.com", "title": "A"},
        {"url": "https://a.com/#frag", "title": "A dup"},  # same card → one entry
        {"url": "https://x.com", "title": "X"},  # dropped by cap → no number
    ]
    numbers = {"https://a.com": 1}
    out = annotate_tool_citations("R", cites, numbers)
    assert out.count("[1]=") == 1
    assert "x.com" not in out


def test_annotate_tool_citations_no_numbers_leaves_content_unchanged():
    assert annotate_tool_citations("R", [{"url": "https://a.com"}], {}) == "R"
