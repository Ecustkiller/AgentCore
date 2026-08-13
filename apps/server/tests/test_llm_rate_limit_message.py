"""Product face of an upstream 429, split by cooldown length and who funds the key.

The engine already refuses to retry past ``MAX_RETRY_AFTER`` (``_rate_limit_should_retry``);
these pin that the *error object* says the same thing — no「请稍后再试」on a cooldown
nobody will wait out — and that the exit offered matches the payer.

They also pin that no branch names a「重试」button: the red error card has none
(定案 A), and the settings exit is「服务商」, the page keys actually live on.
"""

from datetime import UTC, datetime

import httpx
import pytest

from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import (
    MAX_RETRY_AFTER,
    LLMQuotaExceededError,
    LLMRateLimitError,
    format_retry_after_moment,
    upstream_rate_limit_error,
)
from agentcore.llm.errors import error_context_from
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.openai_compatible import (
    _MAX_RETRY_AFTER,
    OpenAICompatibleProvider,
    _rate_limit_should_retry,
)
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest

# Longest cooldown seen in production: an upstream UTC day reset (16.6h).
_DAY_RESET = 59760.0
_NOW = datetime(2026, 8, 13, 8, 48, tzinfo=UTC)
_MOMENT = "8 月 14 日 01:24（UTC）"


def test_rate_limit_error_zh_message_short_retry():
    e = LLMRateLimitError(retry_after=12)
    assert e.code == ErrorCode.LLM_RATE_LIMIT
    assert "上游限流" in e.message
    assert "12" in e.message
    ctx = error_context_from(e)
    assert ctx is not None
    assert ctx.get("retry_after") == 12.0


def test_rate_limit_error_zh_message_long_retry_no_hour_promise():
    e = LLMRateLimitError(retry_after=3600)
    assert "上游限流" in e.message
    assert "3600" not in e.message
    assert "一小时" not in e.message
    ctx = error_context_from(e)
    assert ctx is not None
    assert ctx.get("retry_after") == 3600.0


# ---- single source of the ceiling -------------------------------------------


def test_max_retry_after_is_single_sourced():
    """One constant decides both「引擎重不重试」and「文案怎么说」—— no second 30."""
    assert _MAX_RETRY_AFTER is MAX_RETRY_AFTER
    # The provider protocol层 deliberately does not re-declare it (it would drift
    # from the copy that quotes the same ceiling).
    from agentcore.llm.provider import protocol

    assert not hasattr(protocol, "MAX_RETRY_AFTER")


@pytest.mark.parametrize(
    "retry_after",
    [None, 0.0, 1.0, MAX_RETRY_AFTER, MAX_RETRY_AFTER + 0.1, 3600.0, _DAY_RESET],
)
@pytest.mark.parametrize("source", [None, "user", "platform"])
def test_error_retryable_agrees_with_engine_decision(retry_after, source):
    """The whole point: the object never advertises a retry the loop already refused."""
    err = upstream_rate_limit_error(retry_after, credential_source=source)
    assert err.retryable is _rate_limit_should_retry(retry_after)


# ---- threshold boundary ------------------------------------------------------


@pytest.mark.parametrize("source", [None, "user", "platform"])
def test_exactly_at_ceiling_keeps_the_retryable_seconds_copy(source):
    err = upstream_rate_limit_error(MAX_RETRY_AFTER, credential_source=source, now=_NOW)
    assert isinstance(err, LLMRateLimitError)
    assert err.code == ErrorCode.LLM_RATE_LIMIT
    assert err.retryable is True
    assert err.message == "上游限流，暂时无法继续本回合。请约 30 秒后再试。"
    assert "点重试" not in err.message


@pytest.mark.parametrize("source", [None, "user", "platform"])
def test_just_past_ceiling_stops_promising_a_retry(source):
    err = upstream_rate_limit_error(
        MAX_RETRY_AFTER + 0.1, credential_source=source, now=_NOW
    )
    assert err.retryable is False
    # The copy the user obeyed 2–4 times before: gone on every branch.
    assert "请稍后再试" not in err.message
    assert "点重试" not in err.message
    # Replaced by a concrete recovery moment on every branch.
    assert "（UTC）" in err.message


# ---- the three branches past the ceiling ------------------------------------


def test_platform_day_reset_takes_the_quota_face():
    """Operator-funded allowance wall: reuse QUOTA_EXCEEDED so the client drops the
    retry button and offers the BYOK exit — no new code, no new CTA."""
    err = upstream_rate_limit_error(
        _DAY_RESET, credential_source="platform", now=_NOW, upstream_status=429
    )
    assert isinstance(err, LLMQuotaExceededError)
    assert err.code == ErrorCode.QUOTA_EXCEEDED
    assert err.retryable is False
    assert err.message == (
        f"平台模型额度已用完，本回合无法继续。上游将于 {_MOMENT} 恢复；"
        "或在「设置 · 服务商」接入自己的 API Key 立即继续。"
    )
    # 设置里并列「模型」与「服务商」——从来没有叫「模型配置」的页。
    assert "模型配置" not in err.message
    ctx = error_context_from(err)
    assert ctx is not None
    assert ctx["credential_source"] == "platform"
    assert ctx["retry_after"] == _DAY_RESET


def test_byok_day_reset_keeps_the_rate_limit_face_without_a_key_cta():
    """Telling a user who already brought their own key to bring one is nonsense."""
    err = upstream_rate_limit_error(_DAY_RESET, credential_source="user", now=_NOW)
    assert isinstance(err, LLMRateLimitError)
    assert err.code == ErrorCode.LLM_RATE_LIMIT
    assert err.retryable is False
    assert err.message == (
        f"上游限流，本回合无法继续。你的服务商额度将于 {_MOMENT} 恢复，在此之前重试仍会失败。"
    )
    assert "API Key" not in err.message
    ctx = error_context_from(err)
    assert ctx is not None
    assert ctx["credential_source"] == "user"


def test_unknown_source_day_reset_takes_the_conservative_branch():
    """Unknown payer: rate-limit face, no retry, and no BYOK CTA guessed into it."""
    err = upstream_rate_limit_error(_DAY_RESET, credential_source=None, now=_NOW)
    assert isinstance(err, LLMRateLimitError)
    assert err.code == ErrorCode.LLM_RATE_LIMIT
    assert err.retryable is False
    assert err.message == (
        f"上游限流，本回合无法继续。上游额度将于 {_MOMENT} 恢复，在此之前重试仍会失败。"
    )
    assert "API Key" not in err.message
    assert "credential_source" not in err.details


def test_recovery_moment_is_a_wall_clock_not_an_hour_promise():
    assert format_retry_after_moment(_DAY_RESET, now=_NOW) == _MOMENT
    for err in (
        upstream_rate_limit_error(_DAY_RESET, credential_source="platform", now=_NOW),
        upstream_rate_limit_error(_DAY_RESET, credential_source="user", now=_NOW),
        upstream_rate_limit_error(_DAY_RESET, credential_source=None, now=_NOW),
    ):
        assert _MOMENT in err.message
        assert "16.6" not in err.message
        assert "小时" not in err.message


def test_short_cooldown_never_reaches_the_quota_face():
    """Inside the ceiling a platform 429 is an ordinary retryable throttle."""
    err = upstream_rate_limit_error(5.0, credential_source="platform", now=_NOW)
    assert isinstance(err, LLMRateLimitError)
    assert err.retryable is True
    assert "5 秒" in err.message


# ---- provider seam: the 429 raise site carries the credential source ---------


async def _mock_provider(handler, *, name: str, base_url: str) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(name=name, api_key="k", base_url=base_url)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=base_url, transport=httpx.MockTransport(handler)
    )
    return provider


def _day_reset_429(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        429,
        headers={"retry-after": str(int(_DAY_RESET))},
        content=b'{"error":"rate_limited"}',
    )


def _req() -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
        scenario="chat",
    )


async def test_provider_429_on_platform_key_raises_the_quota_face():
    provider = await _mock_provider(
        _day_reset_429, name="platform", base_url="http://example.invalid/v1"
    )
    try:
        with pytest.raises(LLMQuotaExceededError) as ei:
            await provider.complete(_req())
        assert ei.value.retryable is False
        assert ei.value.details["credential_source"] == "platform"
        assert "（UTC）" in ei.value.message
    finally:
        await provider.close()


async def test_provider_429_on_byok_key_raises_a_non_retryable_rate_limit():
    provider = await _mock_provider(
        _day_reset_429, name="deepseek", base_url="http://example.invalid/v1"
    )
    try:
        with pytest.raises(LLMRateLimitError) as ei:
            await provider.complete(_req())
        assert ei.value.retryable is False
        assert ei.value.retry_after == _DAY_RESET
        assert ei.value.details["credential_source"] == "user"
        assert "你的服务商额度" in ei.value.message
    finally:
        await provider.close()


async def test_provider_429_on_inference_hop_stays_source_agnostic():
    """The sidecar carrier cannot know the payer — guessing would brand a BYOK wall
    as a platform one, so the hop takes the conservative face."""
    provider = await _mock_provider(
        _day_reset_429, name="platform", base_url="http://example.invalid/inference/v1"
    )
    try:
        with pytest.raises(LLMRateLimitError) as ei:
            await provider.complete(_req())
        assert ei.value.retryable is False
        assert "credential_source" not in ei.value.details
        assert "上游额度" in ei.value.message
    finally:
        await provider.close()
