"""429 日志里那个秒数是谁给的：上游声明的冷却，还是我们自己退避出来的等待。

生产 1983 条 ``llm.rate_limit_no_retry`` 里有 138 条记着 ``attempt=5, retry_after=32.0``。
32.0 是整个样本里唯一 ≤60 秒的值、零离散度——因为它根本不是上游给的数，而是我们自己
2→4→8→16→32 退避链的末项：那批 429 压根没带 ``Retry-After`` 头，``_parse_retry_after``
按兜底返回了当次 backoff（兜底本身有理由：不让 429 逃出重试/错误映射变成裸 502），日志却
以 ``retry_after_sec`` 的名义把它记了下来。

字段名让人把它读成「上游说的」，于是有了「上游只要 32 秒，比阈值多 2 秒，稍微放宽就能救
回来」这个判断；真相是「上游什么也没说，我们自己退避重试了 4 次才放弃」——两者要采取的
行动完全不同。这里钉死的是观测面的诚实性：同一批用例同时断言退避链与放弃时机分毫未动。
"""

from __future__ import annotations

import httpx
import pytest

from agentcore.core.errors import (
    MAX_RETRY_AFTER,
    RETRY_AFTER_FROM_BACKOFF,
    RETRY_AFTER_FROM_HEADER,
    RETRY_AFTER_UNKNOWN,
    LLMRateLimitError,
    upstream_rate_limit_error,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider import openai_compatible
from agentcore.llm.provider.openai_compatible import (
    OpenAICompatibleProvider,
    _parse_retry_after,
)
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest
from tests.conftest import LogSpy

# 生产那 138 条里的数字：2→4→8→16→32 的末项，交互上限（30s）之外的第一格。
_LAST_BACKOFF = 32.0
_OUR_BACKOFF_CHAIN = [2.0, 4.0, 8.0, 16.0]
# 另外那 92%：平台号日配额打光，上游真的声明了小时级冷却。
_DAY_RESET = 46440.0


def _req(scenario: str = "title") -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
        scenario=scenario,
    )


async def _mock_provider(handler) -> OpenAICompatibleProvider:
    base_url = "http://example.invalid/v1"
    provider = OpenAICompatibleProvider(name="test", api_key="k", base_url=base_url)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=base_url, transport=httpx.MockTransport(handler)
    )
    return provider


def _throttled(headers: dict[str, str] | None, calls: dict[str, int], *, then_ok: bool = False):
    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if then_ok and calls["n"] > 1:
            return httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1},
                },
            )
        return httpx.Response(429, headers=headers or {}, content=b'{"error":"rate_limited"}')

    return handler


@pytest.fixture
def sleeps(monkeypatch) -> list[float]:
    recorded: list[float] = []

    async def fake_sleep(sec: float) -> None:
        recorded.append(sec)

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)
    return recorded


@pytest.fixture
def spy(monkeypatch) -> LogSpy:
    recorder = LogSpy()
    monkeypatch.setattr(openai_compatible, "logger", recorder)
    return recorder


# ---- 解析层：兜底照旧，但兜底出来的数带着「这是我们的」标签 ------------------------


@pytest.mark.parametrize("raw", [None, "", "   ", "not-a-date"])
def test_an_unusable_header_falls_back_to_our_backoff_and_says_so(raw):
    parsed = _parse_retry_after(raw, 8.0)
    # 兜底不动（audit 01 F9：429 不能逃出重试/错误映射变成裸 502）。
    assert parsed.seconds == 8.0
    # 但没有任何东西可以把它当成上游的表态。
    assert parsed.declared is None
    assert parsed.source == RETRY_AFTER_FROM_BACKOFF


def test_a_real_header_is_the_only_thing_we_may_call_upstreams():
    assert _parse_retry_after("120", 2.0) == (120.0, 120.0)
    assert _parse_retry_after(" 5 ", 2.0).source == RETRY_AFTER_FROM_HEADER


def test_an_expired_http_date_is_our_number_too():
    from datetime import UTC, datetime, timedelta
    from email.utils import format_datetime

    past = format_datetime(datetime.now(UTC) - timedelta(seconds=60))
    parsed = _parse_retry_after(past, 2.0)
    # 头存在，但它给出的冷却早已过期：我们实际用的仍是自己的 backoff。
    assert (parsed.seconds, parsed.declared) == (2.0, None)


# ---- 放弃那条日志：生产那 138 条的形状 -------------------------------------------


async def test_a_headerless_429_never_logs_our_backoff_as_upstreams_word(spy, sleeps):
    """逐字复现被误读的那一行，只是这次它说得出这 32 秒是谁的。"""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await provider.complete(_req())
    finally:
        await provider.close()

    row = spy.get("llm.rate_limit_no_retry")
    assert row["attempt"] == 5
    assert row["cooldown_sec"] == _LAST_BACKOFF
    # 核心断言：上游一个字没说，就不许有字段以「上游声明」的名义呈现这个数。
    assert row["retry_after_sec"] is None
    assert row["cooldown_source"] == RETRY_AFTER_FROM_BACKOFF
    assert row["reason"] == "backoff_exceeds_budget"
    assert row["ceiling_sec"] == MAX_RETRY_AFTER
    # 重试行为一寸未动：仍是 2→4→8→16 睡满四次后在第五次放弃。
    assert sleeps == _OUR_BACKOFF_CHAIN
    assert calls["n"] == 5


async def test_a_declared_cooldown_still_reads_as_upstreams(spy, sleeps):
    """另外那 92%：上游真的声明了小时级冷却，这行字段的含义一个字不变。"""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled({"retry-after": str(_DAY_RESET)}, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await provider.complete(_req())
    finally:
        await provider.close()

    row = spy.get("llm.rate_limit_no_retry")
    assert row["retry_after_sec"] == _DAY_RESET
    assert row["cooldown_sec"] == _DAY_RESET
    assert row["cooldown_source"] == RETRY_AFTER_FROM_HEADER
    assert row["reason"] == "retry_after_too_large"
    # 小时级仍然第一次就放弃，不盲目退避。
    assert (row["attempt"], calls["n"], sleeps) == (1, 1, [])


# ---- 重试那条日志：同一个谎言的隔壁 ----------------------------------------------


async def test_the_retry_line_does_not_borrow_upstreams_authority_either(spy, sleeps):
    """``llm.call_retried`` 也曾把 backoff 记成 ``retry_after_sec``：我们睡了，但没人要求过。"""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls, then_ok=True))
    try:
        result = await provider.complete(_req())
    finally:
        await provider.close()

    assert result.content == "ok"
    row = spy.get("llm.call_retried")
    assert row["wait_sec"] == _OUR_BACKOFF_CHAIN[0]
    assert row["retry_after_sec"] is None
    assert row["cooldown_source"] == RETRY_AFTER_FROM_BACKOFF
    assert sleeps == [_OUR_BACKOFF_CHAIN[0]]


async def test_the_streaming_loop_tells_the_same_story(spy, sleeps):
    """One-shot stream has its own copy of the retry log — title still sits the chain."""
    calls = {"n": 0}
    sse = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(429, content=b'{"error":"rate_limited"}')
        return httpx.Response(200, text=sse)

    provider = await _mock_provider(handler)
    try:
        chunks = [c async for c in provider.stream(_req())]
    finally:
        await provider.close()

    assert any(c.delta_content == "ok" for c in chunks)
    row = spy.get("llm.call_retried")
    assert (row["stream"], row["wait_sec"]) == (True, _OUR_BACKOFF_CHAIN[0])
    assert row["retry_after_sec"] is None
    assert row["cooldown_source"] == RETRY_AFTER_FROM_BACKOFF


async def test_chat_headerless_429_fails_fast_without_our_backoff_chain(spy, sleeps):
    """Interactive turns no longer sit out 2→4→8→16 on a 429 that stated nothing."""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled(None, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await provider.complete(_req("chat"))
    finally:
        await provider.close()

    row = spy.get("llm.rate_limit_no_retry")
    assert (row["attempt"], calls["n"], sleeps) == (1, 1, [])
    assert row["retry_after_sec"] is None
    assert row["cooldown_source"] == RETRY_AFTER_FROM_BACKOFF
    assert row["reason"] == "interactive_fail_fast"
    assert row["scenario"] == "chat"


async def test_chat_short_retry_after_waits_at_most_once(spy, sleeps):
    """Attested ≤2s header: one sleep, then interactive_fail_fast on the next 429."""
    calls = {"n": 0}
    provider = await _mock_provider(_throttled({"retry-after": "2"}, calls))
    try:
        with pytest.raises(LLMRateLimitError):
            await provider.complete(_req("chat"))
    finally:
        await provider.close()

    row = spy.get("llm.rate_limit_no_retry")
    assert sleeps == [2.0]
    assert calls["n"] == 2
    assert row["attempt"] == 2
    assert row["retry_after_sec"] == 2.0
    assert row["cooldown_source"] == RETRY_AFTER_FROM_HEADER
    assert row["reason"] == "interactive_fail_fast"


async def test_chat_stream_headerless_429_fails_fast_too(spy, sleeps):
    """The streaming loop is the turn-scale path — same fail-fast, not a second policy."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(429, content=b'{"error":"rate_limited"}')

    provider = await _mock_provider(handler)
    try:
        with pytest.raises(LLMRateLimitError):
            _ = [c async for c in provider.stream(_req("chat"))]
    finally:
        await provider.close()

    row = spy.get("llm.rate_limit_no_retry")
    assert (row["stream"], row["attempt"], calls["n"], sleeps) == (True, 1, 1, [])
    assert row["reason"] == "interactive_fail_fast"


# ---- 出处跟着异常走，且只走到日志为止 --------------------------------------------


def test_the_cooldown_carries_its_provenance_on_the_error():
    """循环那侧只剩异常，头早没了——判定用的数是谁的，只能由异常自己带过去。"""
    ours = upstream_rate_limit_error(
        _LAST_BACKOFF, credential_source="user", retry_after_source=RETRY_AFTER_FROM_BACKOFF
    )
    assert ours.retry_after == _LAST_BACKOFF
    assert ours.retry_after_source == RETRY_AFTER_FROM_BACKOFF
    # 跨 /inference/ hop 转述来的那个数：既不是我们看见的头，也无从作证。
    assert upstream_rate_limit_error(_LAST_BACKOFF).retry_after_source == RETRY_AFTER_UNKNOWN


def test_provenance_is_observability_only_and_stays_off_the_wire():
    """只服务日志：不进 details，就不会漂进 SSE ErrorContext / history 契约。"""
    error = upstream_rate_limit_error(
        _DAY_RESET, credential_source="user", retry_after_source=RETRY_AFTER_FROM_HEADER
    )
    assert "retry_after_source" not in error.details
    assert error.details["retry_after"] == _DAY_RESET
    # 也不动重试判定：同一个数在同一个上限下给同一个 retryable。
    assert error.retryable is False
    assert (
        upstream_rate_limit_error(
            5.0, credential_source="user", retry_after_source=RETRY_AFTER_FROM_BACKOFF
        ).retryable
        is True
    )
