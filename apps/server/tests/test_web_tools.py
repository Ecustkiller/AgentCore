"""Tests for the web tools (search backend, SSRF guard, extraction, breaker).

Pure logic + offline paths only — no real network. SSRF rejection is verified by
calling ``read_url`` against private/blocked hosts (classification short-circuits
before any request), and search parsing is tested via the pure ``_parse_results``.
"""

import asyncio
import json
import time
from pathlib import Path

import httpx
import pytest

from agentcore.core.net import (
    URLBlock as _URLBlock,
)
from agentcore.core.net import (
    classify_url as _classify_url,
)
from agentcore.core.net import (
    ip_is_safe as _ip_is_safe,
)
from agentcore.runtime.citations import annotate_tool_citations, merge_citations
from agentcore.tools.builtin.web import _net
from agentcore.tools.builtin.web import read_url as read_url_mod
from agentcore.tools.builtin.web import search as search_mod
from agentcore.tools.builtin.web import search_backend as search_backend_mod
from agentcore.tools.builtin.web import search_cache as search_cache_mod
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
    _extract_page,
    _extract_text,
    _make_snippet,
)
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.builtin.web.search_backend import (
    FallbackSearchBackend,
    SearchResult,
    SearXNGBackend,
    TavilyBackend,
    _parse_results,
)
from agentcore.tools.builtin.web.search_cache import (
    ConversationSearchCache,
    SearchCacheEntry,
    SearchCacheRegistry,
)
from agentcore.tools.builtin.web.url_cache import (
    ConversationUrlCache,
    UrlCacheEntry,
    UrlCacheRegistry,
)
from agentcore.tools.protocol import ToolContext, ToolResult
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace


def _ctx(conversation_id: str = "") -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
        conversation_id=conversation_id,
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


async def test_searxng_breaker_message_is_honest():
    # An open breaker must NOT claim "未就绪/出网受限" (it opens on repeated request
    # failures, usually overload under a parallel burst — SearXNG is typically up).
    host = "localhost"
    _net._states.pop(host, None)
    for _ in range(_net.WEB_HOST_FAIL_THRESHOLD):
        note_failure(host)

    backend = SearXNGBackend("http://localhost:18888")
    with pytest.raises(EgressError) as ei:
        await backend.search("q")
    msg = str(ei.value)
    assert "熔断" in msg
    assert host in msg
    assert "未就绪" not in msg and "出网受限" not in msg
    _net._states.pop(host, None)


async def test_searxng_backend_caps_concurrent_requests(monkeypatch):
    # A parallel team can fire dozens of searches at once; the backend semaphore must
    # cap simultaneous hits on the single SearXNG instance so the burst queues into
    # waves instead of saturating it (which is what trips the breaker for everyone).
    host = "localhost"
    _net._states.pop(host, None)
    req = httpx.Request("GET", "http://localhost:18888/search")
    payload = {"results": [{"url": "https://e.com/a", "title": "A", "content": "x"}]}

    state = {"inflight": 0, "peak": 0}
    gate = asyncio.Event()

    class _GatedClient:
        async def get(self, *args, **kwargs):
            state["inflight"] += 1
            state["peak"] = max(state["peak"], state["inflight"])
            try:
                await gate.wait()  # hold the slot open until released
            finally:
                state["inflight"] -= 1
            return httpx.Response(200, json=payload, request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _GatedClient())

    backend = SearXNGBackend("http://localhost:18888")
    cap = search_backend_mod._SEARCH_CONCURRENCY
    tasks = [asyncio.create_task(backend.search("q")) for _ in range(cap + 4)]
    for _ in range(100):  # pump the loop until the gate fills to the ceiling
        await asyncio.sleep(0)
        if state["inflight"] >= cap:
            break
    assert state["inflight"] == cap  # extra tasks are parked on the semaphore, not in flight

    gate.set()  # release; the parked tasks drain in a second wave
    results = await asyncio.gather(*tasks)
    assert state["peak"] == cap  # never exceeded the cap
    assert all(len(r) == 1 for r in results)
    _net._states.pop(host, None)


# --- search_backend: token-bucket rate limiter (B3 CAPTCHA defence) ---


async def test_token_bucket_allows_burst_then_paces():
    # Starts full (capacity tokens) so a burst passes instantly; once drained the next
    # token can't arrive faster than the refill rate — that paces the sustained rate that
    # CAPTCHA keys on. Lower-bound timing only (robust on slow CI).
    bucket = search_backend_mod._TokenBucket(rate_per_sec=20.0, capacity=2.0)
    await bucket.acquire()
    await bucket.acquire()  # burst of 2 drained
    start = time.monotonic()
    await bucket.acquire()  # must wait ~1/20s for the next token
    assert (time.monotonic() - start) >= 0.03


async def test_token_bucket_refills_over_elapsed_time():
    # Refill is proportional to elapsed time: simulate time passing by backdating the
    # update clock, then a drained bucket serves again without a real wait.
    bucket = search_backend_mod._TokenBucket(rate_per_sec=10.0, capacity=1.0)
    await bucket.acquire()  # drained
    bucket._updated -= 1.0  # pretend 1s elapsed → ~10 tokens refilled (capped at capacity)
    await asyncio.wait_for(bucket.acquire(), timeout=0.5)  # served from refill, no long wait


async def test_searxng_backend_acquires_rate_token_per_search(monkeypatch):
    # Regression guard: every outbound search must pass the rate-limit bucket (so the
    # CAPTCHA-defence pacing can't be silently dropped from the request path).
    host = "localhost"
    _net._states.pop(host, None)
    req = httpx.Request("GET", "http://localhost:18888/search")
    payload = {"results": [{"url": "https://e.com/a", "title": "A", "content": "x"}]}

    class _OkClient:
        async def get(self, *args, **kwargs):
            return httpx.Response(200, json=payload, request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _OkClient())

    backend = SearXNGBackend("http://localhost:18888")
    acquired = {"n": 0}
    bucket = backend._get_bucket()
    real_acquire = bucket.acquire

    async def _counting_acquire():
        acquired["n"] += 1
        await real_acquire()

    monkeypatch.setattr(bucket, "acquire", _counting_acquire)

    await backend.search("q")
    await backend.search("q")
    assert acquired["n"] == 2
    _net._states.pop(host, None)


async def test_searxng_backend_retries_transient_5xx_then_succeeds(monkeypatch):
    host = "localhost"
    _net._states.pop(host, None)
    monkeypatch.setattr(search_backend_mod, "_SEARCH_RETRY_BASE_S", 0.0)
    monkeypatch.setattr(search_backend_mod, "_SEARCH_RETRY_JITTER_S", 0.0)

    req = httpx.Request("GET", "http://localhost:18888/search")
    payload = {"results": [{"url": "https://e.com/a", "title": "A", "content": "x"}]}

    class _FlakyClient:
        def __init__(self):
            self.calls = 0

        async def get(self, *args, **kwargs):
            self.calls += 1
            if self.calls < 2:  # first attempt 502, retry succeeds
                return httpx.Response(502, request=req)
            return httpx.Response(200, json=payload, request=req)

    client = _FlakyClient()
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client)

    backend = SearXNGBackend("http://localhost:18888")
    results = await backend.search("q")

    assert client.calls == 2  # retried once past the 502
    assert [r.url for r in results] == ["https://e.com/a"]
    # success on the retry clears the breaker — no failure recorded
    assert host not in _net._states


async def test_searxng_backend_gives_up_after_persistent_5xx(monkeypatch):
    host = "localhost"
    _net._states.pop(host, None)
    monkeypatch.setattr(search_backend_mod, "_SEARCH_RETRY_BASE_S", 0.0)
    monkeypatch.setattr(search_backend_mod, "_SEARCH_RETRY_JITTER_S", 0.0)

    req = httpx.Request("GET", "http://localhost:18888/search")

    class _AllFailClient:
        def __init__(self):
            self.calls = 0

        async def get(self, *args, **kwargs):
            self.calls += 1
            return httpx.Response(502, request=req)

    client = _AllFailClient()
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client)

    backend = SearXNGBackend("http://localhost:18888")
    with pytest.raises(httpx.HTTPStatusError):
        await backend.search("q")

    assert client.calls == search_backend_mod._SEARCH_ATTEMPTS  # exhausted the retries
    # one breaker failure per CALL (not one per internal attempt)
    assert _net._states[host].fails == 1


async def test_searxng_backend_does_not_retry_4xx(monkeypatch):
    host = "localhost"
    _net._states.pop(host, None)
    req = httpx.Request("GET", "http://localhost:18888/search")

    class _ClientErrClient:
        def __init__(self):
            self.calls = 0

        async def get(self, *args, **kwargs):
            self.calls += 1
            return httpx.Response(400, request=req)

    client = _ClientErrClient()
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: client)

    backend = SearXNGBackend("http://localhost:18888")
    with pytest.raises(httpx.HTTPStatusError):
        await backend.search("q")

    assert client.calls == 1  # client errors are not retried
    assert host not in _net._states  # nor counted against the breaker


async def test_probe_search_backend_reports_reachable(monkeypatch):
    monkeypatch.setattr(search_backend_mod, "_backend", None)
    req = httpx.Request("GET", "http://localhost:18888/healthz")

    class _OkClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            return httpx.Response(200, text="OK", request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _OkClient())
    assert await search_backend_mod.probe_search_backend() == (True, "http://localhost:18888")


async def test_probe_search_backend_reports_unreachable(monkeypatch):
    # A down dependency must be reported, never raised — startup can't be broken by it.
    monkeypatch.setattr(search_backend_mod, "_backend", None)

    class _DownClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _DownClient())
    result = await search_backend_mod.probe_search_backend()
    assert result is not None
    ok, detail = result
    assert ok is False
    assert "ConnectError" in detail


async def test_probe_search_results_reports_ok(monkeypatch):
    # The real-search canary (D5): a query that returns ≥1 result confirms the engine
    # pool actually works, not just that /healthz is 200.
    class _Backend:
        async def search(self, query, max_results=5):
            return [SearchResult("t", "https://a.com", "s")]

    monkeypatch.setattr(search_backend_mod, "_backend", _Backend())
    assert await search_backend_mod.probe_search_results() == (True, 1)


async def test_probe_search_results_flags_empty(monkeypatch):
    # The production failure mode: SearXNG healthz-200 but every engine CAPTCHA-suspended
    # → real search returns empty. The canary must surface this (ok=False), unlike the
    # reachability probe which would still report healthy.
    class _Backend:
        async def search(self, query, max_results=5):
            return []

    monkeypatch.setattr(search_backend_mod, "_backend", _Backend())
    assert await search_backend_mod.probe_search_results() == (False, 0)


async def test_probe_search_results_never_raises(monkeypatch):
    # Best-effort like the reachability probe: a failing search must never break startup.
    class _Backend:
        async def search(self, query, max_results=5):
            raise httpx.ConnectError("down")

    monkeypatch.setattr(search_backend_mod, "_backend", _Backend())
    assert await search_backend_mod.probe_search_results() is None


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


# --- search_backend: Tavily fallback leg ---


async def test_tavily_backend_parses_results_and_sends_bearer(monkeypatch):
    # Tavily's result objects share SearXNG's title/url/content shape, so the same
    # _parse_results handles both. Verify the request carries the Bearer key + query.
    captured: dict = {}
    req = httpx.Request("POST", "https://api.tavily.com/search")
    payload = {
        "results": [
            {"title": "T1", "url": "https://a.com", "content": "snip a", "score": 0.9},
            {"title": "T2", "url": "https://b.com", "content": "snip b", "score": 0.8},
        ]
    }

    class _Client:
        async def post(self, url, json=None, headers=None):
            captured["url"] = url
            captured["json"] = json
            captured["headers"] = headers
            return httpx.Response(200, json=payload, request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _Client())

    backend = TavilyBackend(api_key="tvly-test", base_url="https://api.tavily.com")
    results = await backend.search("深圳天气", max_results=2)

    assert [(r.title, r.url, r.snippet) for r in results] == [
        ("T1", "https://a.com", "snip a"),
        ("T2", "https://b.com", "snip b"),
    ]
    assert captured["url"] == "https://api.tavily.com/search"
    assert captured["headers"]["Authorization"] == "Bearer tvly-test"
    assert captured["json"]["query"] == "深圳天气"
    assert captured["json"]["max_results"] == 2


async def test_tavily_backend_requires_api_key():
    # Defensive: an unconfigured Tavily leg fails honestly rather than calling the API.
    backend = TavilyBackend(api_key="", base_url="https://api.tavily.com")
    with pytest.raises(EgressError, match="API key"):
        await backend.search("q")


async def test_tavily_backend_raises_on_http_error(monkeypatch):
    req = httpx.Request("POST", "https://api.tavily.com/search")

    class _Client:
        async def post(self, *args, **kwargs):
            return httpx.Response(401, request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _Client())
    backend = TavilyBackend(api_key="tvly-bad", base_url="https://api.tavily.com")
    with pytest.raises(httpx.HTTPStatusError):
        await backend.search("q")


class _StubBackend:
    """Minimal SearchBackend: returns canned results or raises a canned error."""

    def __init__(self, results=None, exc=None):
        self._results = results or []
        self._exc = exc
        self.calls = 0

    async def search(self, query, max_results=5):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._results


async def test_fallback_uses_primary_on_success():
    # A successful primary never touches the fallback (no per-query Tavily cost).
    primary = _StubBackend(results=[SearchResult("P", "https://p.com", "ps")])
    fallback = _StubBackend(results=[SearchResult("F", "https://f.com", "fs")])
    results = await FallbackSearchBackend(primary, fallback).search("q")

    assert [r.url for r in results] == ["https://p.com"]
    assert primary.calls == 1
    assert fallback.calls == 0


async def test_fallback_switches_on_primary_failure():
    # The 案例1 mode: SearXNG breaker open → retry once via Tavily.
    primary = _StubBackend(exc=EgressError("熔断"))
    fallback = _StubBackend(results=[SearchResult("F", "https://f.com", "fs")])
    results = await FallbackSearchBackend(primary, fallback).search("q")

    assert [r.url for r in results] == ["https://f.com"]
    assert primary.calls == 1 and fallback.calls == 1


async def test_fallback_surfaces_primary_error_when_both_fail():
    # Both down → the PRIMARY's (already-tuned, honest) reason is what the model sees.
    primary = _StubBackend(exc=EgressError("主熔断信息"))
    fallback = _StubBackend(exc=httpx.ConnectError("tavily down"))

    with pytest.raises(EgressError, match="主熔断信息"):
        await FallbackSearchBackend(primary, fallback).search("q")


async def test_fallback_aclose_closes_both_legs():
    closed: list[str] = []

    class _Closeable(_StubBackend):
        def __init__(self, name):
            super().__init__()
            self._name = name

        async def aclose(self):
            closed.append(self._name)

    await FallbackSearchBackend(_Closeable("p"), _Closeable("f")).aclose()
    assert sorted(closed) == ["f", "p"]


def test_get_search_backend_is_bare_searxng_without_tavily(monkeypatch):
    monkeypatch.setattr(search_backend_mod, "_backend", None)
    monkeypatch.setattr(search_backend_mod.settings, "tavily_api_key", "")
    assert isinstance(search_backend_mod.get_search_backend(), SearXNGBackend)


def test_get_search_backend_wraps_fallback_when_tavily_configured(monkeypatch):
    monkeypatch.setattr(search_backend_mod, "_backend", None)
    monkeypatch.setattr(search_backend_mod.settings, "tavily_api_key", "tvly-x")
    backend = search_backend_mod.get_search_backend()
    assert isinstance(backend, FallbackSearchBackend)
    assert isinstance(backend.primary, SearXNGBackend)
    assert isinstance(backend.fallback, TavilyBackend)


async def test_probe_unwraps_fallback_to_probe_searxng_primary(monkeypatch):
    # With Tavily configured the active backend is the wrapper; probe must still
    # reach the SearXNG primary behind it (Tavily has nothing SearXNG-specific).
    monkeypatch.setattr(search_backend_mod, "_backend", None)
    monkeypatch.setattr(search_backend_mod.settings, "tavily_api_key", "tvly-x")
    req = httpx.Request("GET", "http://localhost:18888/healthz")

    class _OkClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, *args, **kwargs):
            return httpx.Response(200, text="OK", request=req)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: _OkClient())
    assert await search_backend_mod.probe_search_backend() == (True, "http://localhost:18888")


async def test_aclose_search_backend_closes_and_resets(monkeypatch):
    closed = {"n": 0}

    class _Closeable:
        async def search(self, *a, **k):
            return []

        async def aclose(self):
            closed["n"] += 1

    monkeypatch.setattr(search_backend_mod, "_backend", _Closeable())
    await search_backend_mod.aclose_search_backend()
    assert closed["n"] == 1
    assert search_backend_mod._backend is None


# --- search_cache: web_search conversation result cache (案例1 #5 检索去重) ---


def _sresult(url: str, title: str = "T", snippet: str = "s") -> SearchResult:
    return SearchResult(title=title, url=url, snippet=snippet)


def _sentry(query: str, results, *, max_results: int = 8, stored_at=None) -> SearchCacheEntry:
    return SearchCacheEntry(
        query=query,
        results=results,
        max_results=max_results,
        stored_at=time.time() if stored_at is None else stored_at,
    )


def test_search_cache_get_put_and_key_normalization():
    cache = ConversationSearchCache()
    cache.put(_sentry("Hello World", [_sresult("https://a.com")]))
    # trimmed + lowercased + whitespace-collapsed normalises to the same key
    assert cache.get("  hello   world ", min_results=1) is not None
    assert "HELLO world" in cache
    assert cache.get("other", min_results=1) is None


def test_search_cache_capped_entry_needs_refetch_for_more():
    cache = ConversationSearchCache()
    # returned exactly the cap (5) → more results may exist upstream
    cache.put(_sentry("q", [_sresult(f"https://a/{i}") for i in range(5)], max_results=5))
    assert cache.get("q", min_results=5) is not None  # enough captured
    assert cache.get("q", min_results=8) is None  # wants more than the capped set


def test_search_cache_under_cap_entry_serves_any_request():
    cache = ConversationSearchCache()
    # backend returned fewer (2) than the cap (8) → that's everything it had
    cache.put(_sentry("q", [_sresult("https://a/1"), _sresult("https://a/2")], max_results=8))
    assert cache.get("q", min_results=50) is not None


def test_search_cache_expires_after_ttl():
    cache = ConversationSearchCache(ttl_seconds=10.0)
    cache.put(_sentry("q", [_sresult("https://a")], stored_at=time.time() - 100))
    assert cache.get("q", min_results=1) is None


def test_search_cache_negative_marks_and_serves_recently_empty():
    # A1 防重搜风暴: a query that just came back empty is remembered (negatively) so an
    # immediate re-issue is served empty without a network hit. Normalised like the
    # positive key, so trivially-different spellings collapse to one marker.
    cache = ConversationSearchCache()
    assert cache.is_recently_empty("q") is False
    cache.note_empty("  Q ")  # normalises to the same key as "q"
    assert cache.is_recently_empty("q") is True
    assert cache.is_recently_empty("other") is False


def test_search_cache_negative_marker_expires():
    cache = ConversationSearchCache(empty_ttl_seconds=100.0)
    cache.note_empty("q")
    assert cache.is_recently_empty("q") is True
    cache._empty["q"] = time.time() - 1000  # backdate past the (short) empty TTL
    assert cache.is_recently_empty("q") is False  # expired → a genuine retry is allowed


def test_search_cache_positive_result_clears_negative_marker():
    # A real result supersedes a stale "recently empty" marker (engines recovered).
    cache = ConversationSearchCache()
    cache.note_empty("q")
    assert cache.is_recently_empty("q") is True
    cache.put(_sentry("q", [_sresult("https://a.com")]))
    assert cache.is_recently_empty("q") is False
    assert cache.get("q", min_results=1) is not None


def test_search_cache_negative_lru_caps_entries():
    # The negative cache is bounded like the positive one (oldest marker evicted).
    cache = ConversationSearchCache(max_entries=2)
    for i in range(3):
        cache.note_empty(f"q{i}")
    assert cache.is_recently_empty("q0") is False  # oldest empty marker evicted
    assert cache.is_recently_empty("q2") is True


def test_search_cache_lru_evicts_over_count():
    cache = ConversationSearchCache(max_entries=2)
    for i in range(3):
        cache.put(_sentry(f"q{i}", [_sresult(f"https://s{i}.com")]))
    assert len(cache) == 2
    assert "q0" not in cache  # oldest evicted
    assert "q2" in cache


def test_search_cache_lru_evicts_over_bytes():
    cache = ConversationSearchCache(max_bytes=60)
    cache.put(_sentry("q0", [_sresult("https://a.com", snippet="x" * 30)]))
    cache.put(_sentry("q1", [_sresult("https://b.com", snippet="y" * 30)]))  # total > 60
    assert "q0" not in cache  # oldest evicted to fit the byte budget
    assert "q1" in cache


def test_search_cache_registry_scopes_per_conversation():
    reg = SearchCacheRegistry()
    c1 = reg.get_or_create("c1")
    c2 = reg.get_or_create("c2")
    assert c1 is not c2
    assert reg.get_or_create("c1") is c1


def test_search_cache_registry_caps_conversation_count_lru():
    reg = SearchCacheRegistry(max_conversations=2)
    reg.get_or_create("a")
    reg.get_or_create("b")
    reg.get_or_create("c")
    assert len(reg) == 2
    assert "a" not in reg  # LRU-evicted
    assert "c" in reg


def test_search_cache_registry_reaps_idle_conversation():
    reg = SearchCacheRegistry(conversation_ttl_seconds=10.0)
    idle = reg.get_or_create("idle")
    idle.last_access = time.time() - 100  # force past the idle window
    reg.get_or_create("fresh")  # creation triggers idle reaping
    assert "idle" not in reg
    assert "fresh" in reg


async def test_web_search_caches_within_conversation(monkeypatch):
    monkeypatch.setattr(search_cache_mod, "_registry", SearchCacheRegistry())
    calls = {"n": 0}

    class _Backend:
        async def search(self, query, max_results=5):
            calls["n"] += 1
            return [SearchResult("标题", "https://a.com", "摘要")]

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _Backend())
    ctx = _ctx(conversation_id="conv-search-cache")
    tool = WebSearchTool()
    r1 = await tool.execute({"query": "深圳天气"}, ctx)
    r2 = await tool.execute({"query": "  深圳天气 "}, ctx)  # normalises to the same key

    assert r1.success and r2.success
    assert calls["n"] == 1  # second served from cache, no re-search
    assert r1.metadata.get("cached") is not True
    assert r2.metadata.get("cached") is True
    assert r2.output == r1.output  # cached hit has the identical result shape


async def test_web_search_skips_cache_without_conversation(monkeypatch):
    monkeypatch.setattr(search_cache_mod, "_registry", SearchCacheRegistry())
    calls = {"n": 0}

    class _Backend:
        async def search(self, query, max_results=5):
            calls["n"] += 1
            return [SearchResult("t", "https://a.com", "s")]

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _Backend())
    tool = WebSearchTool()
    await tool.execute({"query": "q"}, _ctx())  # conversation_id == "" → no caching
    await tool.execute({"query": "q"}, _ctx())
    assert calls["n"] == 2


async def test_web_search_empty_result_negatively_cached(monkeypatch):
    # CAPTCHA / transient empty (HTTP 200 + results:[]) → negatively cached briefly so a
    # degraded worker re-issuing the SAME empty query doesn't restorm SearXNG (案例1 重搜
    # 风暴). The marker expires fast, so once the transient cause likely cleared the query
    # genuinely re-searches.
    reg = SearchCacheRegistry()
    monkeypatch.setattr(search_cache_mod, "_registry", reg)
    calls = {"n": 0}

    class _Backend:
        async def search(self, query, max_results=5):
            calls["n"] += 1
            return []

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _Backend())
    ctx = _ctx(conversation_id="conv-empty")
    tool = WebSearchTool()

    r1 = await tool.execute({"query": "q"}, ctx)
    r2 = await tool.execute({"query": "q"}, ctx)  # within window → served empty, no re-search
    assert r1.success and r2.success
    assert calls["n"] == 1  # second suppressed by the negative cache
    assert r2.metadata.get("cached") is True
    assert r2.metadata.get("result_count") == 0

    # once the negative marker ages past its TTL, the same query genuinely re-searches
    reg.get_or_create("conv-empty")._empty["q"] = time.time() - 10_000
    await tool.execute({"query": "q"}, ctx)
    assert calls["n"] == 2


async def test_web_search_empty_result_is_honest(monkeypatch):
    # D5: an empty set is success (HTTP 200, no transport failure) but must carry an
    # explicit note + ``empty`` flag so the model doesn't read silence as "this doesn't
    # exist" — a CAPTCHA-suspended engine returns HTTP 200 + zero results all the same.
    class _Backend:
        async def search(self, query, max_results=5):
            return []

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _Backend())
    result = await WebSearchTool().execute({"query": "q"}, _ctx())

    assert result.success is True
    assert result.metadata.get("empty") is True
    assert result.metadata.get("result_count") == 0
    payload = json.loads(result.output)
    assert payload["results"] == []
    assert payload.get("note")  # an actionable, non-empty hint for the model
    assert result.citations is None  # nothing to cite


async def test_web_search_cache_refetches_when_more_results_needed(monkeypatch):
    monkeypatch.setattr(search_cache_mod, "_registry", SearchCacheRegistry())
    calls = {"n": 0}

    class _Backend:
        async def search(self, query, max_results=5):
            calls["n"] += 1
            # always return exactly max_results (capped) → "more may exist"
            return [SearchResult(f"t{i}", f"https://a.com/{i}", "s") for i in range(max_results)]

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _Backend())
    ctx = _ctx(conversation_id="conv-more")
    tool = WebSearchTool()
    await tool.execute({"query": "q", "max_results": 3}, ctx)
    assert calls["n"] == 1
    # wants MORE than the capped cached set → re-search with the bigger budget
    await tool.execute({"query": "q", "max_results": 8}, ctx)
    assert calls["n"] == 2
    # now 8 are cached → a <=8 request hits without re-searching
    await tool.execute({"query": "q", "max_results": 5}, ctx)
    assert calls["n"] == 2


# --- ToolResult.output_limit ---


def test_tool_result_default_truncates_head_and_tail_at_4000():
    body = "HEAD起始" + ("a" * 5000) + "TAIL尾注金额￥999"
    r = ToolResult(tool_call_id="", success=True, output=body)
    assert r.output.startswith("HEAD起始")  # head kept
    assert r.output.endswith("TAIL尾注金额￥999")  # tail kept — head-only used to drop it
    assert "保留首尾" in r.output  # elision marker between the ends
    assert len(r.output) <= 4000


def test_tool_result_respects_higher_output_limit():
    body = "a" * 5000
    r = ToolResult(tool_call_id="", success=True, output=body, output_limit=8000)
    assert r.output == body  # under budget → untouched


def test_tool_result_custom_lower_limit_keeps_both_ends():
    body = "HEAD" + ("a" * 1000) + "TAIL"
    r = ToolResult(tool_call_id="", success=True, output=body, output_limit=200)
    assert r.output.startswith("HEAD")
    assert r.output.endswith("TAIL")
    assert len(r.output) <= 200


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


async def test_web_search_emits_structured_display(monkeypatch):
    # 工具结果富渲染: the client renders the hits as cards from ``display`` (not the
    # JSON output), so it carries each hit's title/url/snippet + parsed site.
    class _FakeBackend:
        async def search(self, query, max_results=5):
            return [
                SearchResult("标题一", "https://www.example.com/a", "摘要一"),
                SearchResult("标题二", "https://b.cn/p", "摘要二"),
            ]

    monkeypatch.setattr(search_mod, "get_search_backend", lambda: _FakeBackend())
    result = await WebSearchTool().execute({"query": "深圳天气"}, _ctx())

    assert result.success is True
    assert result.display == {
        "query": "深圳天气",
        "results": [
            {
                "title": "标题一",
                "url": "https://www.example.com/a",
                "snippet": "摘要一",
                "site": "example.com",
            },
            {"title": "标题二", "url": "https://b.cn/p", "snippet": "摘要二", "site": "b.cn"},
        ],
    }


def test_merge_citations_dedups_across_rounds_by_normalized_url():
    sink: list[dict] = []
    first = merge_citations(sink, [{"url": "https://a.com/p", "title": "A", "site": "a.com"}])
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


# --- read_url conversation-scoped fetch cache (P2) ---


async def test_read_url_caches_within_conversation(monkeypatch):
    html = (
        "<html><head><title>缓存页</title>"
        '<meta name="description" content="摘要">'
        "</head><body><p>正文内容</p></body></html>"
    )
    calls = {"n": 0}

    async def _allow(_url: str):
        return None

    async def _fake_request(_client, _method, url, **_kwargs):
        calls["n"] += 1
        return httpx.Response(200, html=html, request=httpx.Request("GET", url))

    monkeypatch.setattr(read_url_mod, "_classify_url", _allow)
    monkeypatch.setattr(read_url_mod, "_safe_request", _fake_request)

    ctx = _ctx(conversation_id="conv-cache-hit")
    tool = ReadUrlTool()
    r1 = await tool.execute({"url": "https://x.example.com/p"}, ctx)
    r2 = await tool.execute({"url": "https://x.example.com/p"}, ctx)

    assert r1.success and r2.success
    assert calls["n"] == 1  # second read served from cache, no re-fetch
    assert r1.metadata.get("cached") is not True
    assert r2.metadata.get("cached") is True
    # the cached hit preserves content + citation metadata
    assert "正文内容" in r2.output
    assert r2.citations[0]["title"] == "缓存页"
    assert r2.citations[0]["snippet"] == "摘要"
    assert r2.citations[0]["site"] == "x.example.com"
    # same page via trailing slash + fragment normalises to the same cache key
    r3 = await tool.execute({"url": "https://x.example.com/p/#sec"}, ctx)
    assert calls["n"] == 1
    assert r3.metadata.get("cached") is True


async def test_read_url_skips_cache_without_conversation(monkeypatch):
    html = "<html><head><title>T</title></head><body><p>x</p></body></html>"
    calls = {"n": 0}

    async def _allow(_url: str):
        return None

    async def _fake_request(_client, _method, url, **_kwargs):
        calls["n"] += 1
        return httpx.Response(200, html=html, request=httpx.Request("GET", url))

    monkeypatch.setattr(read_url_mod, "_classify_url", _allow)
    monkeypatch.setattr(read_url_mod, "_safe_request", _fake_request)

    tool = ReadUrlTool()
    await tool.execute({"url": "https://nocache.example.com/a"}, _ctx())
    await tool.execute({"url": "https://nocache.example.com/a"}, _ctx())
    assert calls["n"] == 2  # unscoped (conversation_id == "") → no caching, fetched twice


async def test_read_url_cache_refetches_when_more_chars_needed(monkeypatch):
    body = "<html><body><p>" + ("z" * 500) + "</p></body></html>"
    calls = {"n": 0}

    async def _allow(_url: str):
        return None

    async def _fake_request(_client, _method, url, **_kwargs):
        calls["n"] += 1
        return httpx.Response(200, html=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(read_url_mod, "_classify_url", _allow)
    monkeypatch.setattr(read_url_mod, "_safe_request", _fake_request)

    ctx = _ctx(conversation_id="conv-cache-chars")
    tool = ReadUrlTool()
    # first read captures only 100 chars (truncated); a later read needing 400 must
    # re-fetch with the bigger budget rather than serve the short cached copy.
    await tool.execute({"url": "https://big.example.com/p", "max_chars": 100}, ctx)
    assert calls["n"] == 1
    r2 = await tool.execute({"url": "https://big.example.com/p", "max_chars": 400}, ctx)
    assert calls["n"] == 2
    assert r2.metadata.get("cached") is not True
    # now 400 chars are cached → a <=400 request hits without re-fetching
    r3 = await tool.execute({"url": "https://big.example.com/p", "max_chars": 300}, ctx)
    assert calls["n"] == 2
    assert r3.metadata.get("cached") is True


def _entry(
    url: str, content: str = "body", *, max_chars: int = 8000, truncated: bool = False
) -> UrlCacheEntry:
    return UrlCacheEntry(
        url=url,
        title="T",
        content=content,
        snippet="s",
        site=site_of(url),
        max_chars=max_chars,
        truncated=truncated,
        stored_at=time.time(),
    )


def test_url_cache_get_put_and_key_normalization():
    cache = ConversationUrlCache()
    cache.put(_entry("https://a.com/p"))
    # trailing slash + fragment normalise to the same key as the stored URL
    assert cache.get("https://a.com/p/#frag", min_chars=8000) is not None
    assert "https://a.com/p" in cache
    assert cache.get("https://other.com", min_chars=1) is None


def test_url_cache_truncated_entry_needs_refetch_for_more_chars():
    cache = ConversationUrlCache()
    cache.put(_entry("https://a.com", content="x" * 100, max_chars=100, truncated=True))
    assert cache.get("https://a.com", min_chars=100) is not None  # enough captured
    assert cache.get("https://a.com", min_chars=200) is None  # wants more than captured


def test_url_cache_full_entry_serves_any_char_request():
    cache = ConversationUrlCache()
    cache.put(_entry("https://a.com", content="short", truncated=False))
    # a non-truncated entry holds the whole page → even a larger ask is a hit
    assert cache.get("https://a.com", min_chars=99999) is not None


def test_url_cache_expires_after_ttl():
    cache = ConversationUrlCache(ttl_seconds=10.0)
    stale = _entry("https://a.com")
    stale.stored_at = time.time() - 100  # older than the TTL window
    cache.put(stale)
    assert cache.get("https://a.com", min_chars=1) is None


def test_url_cache_lru_evicts_over_count():
    cache = ConversationUrlCache(max_entries=2)
    for i in range(3):
        cache.put(_entry(f"https://s{i}.com", content="x"))
    assert len(cache) == 2
    assert "https://s0.com" not in cache  # oldest evicted
    assert "https://s2.com" in cache


def test_url_cache_lru_evicts_over_bytes():
    cache = ConversationUrlCache(max_bytes=10)
    cache.put(_entry("https://a.com", content="x" * 8))
    cache.put(_entry("https://b.com", content="y" * 8))  # total 16 > 10
    assert "https://a.com" not in cache  # oldest evicted to fit the byte budget
    assert "https://b.com" in cache


def test_url_cache_registry_scopes_per_conversation():
    reg = UrlCacheRegistry()
    c1 = reg.get_or_create("conv1")
    c2 = reg.get_or_create("conv2")
    assert c1 is not c2
    assert reg.get_or_create("conv1") is c1  # stable per conversation


def test_url_cache_registry_caps_conversation_count_lru():
    reg = UrlCacheRegistry(max_conversations=2)
    reg.get_or_create("a")
    reg.get_or_create("b")
    reg.get_or_create("c")
    assert len(reg) == 2
    assert "a" not in reg  # LRU-evicted
    assert "c" in reg


def test_url_cache_registry_reaps_idle_conversation():
    reg = UrlCacheRegistry(conversation_ttl_seconds=10.0)
    idle = reg.get_or_create("idle")
    idle.last_access = time.time() - 100  # force past the idle window
    reg.get_or_create("fresh")  # creation triggers idle reaping
    assert "idle" not in reg
    assert "fresh" in reg
