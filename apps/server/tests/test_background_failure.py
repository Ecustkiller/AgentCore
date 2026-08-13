"""Unit tests for side-path LLM failure reason buckets."""

from agentcore.core.errors import (
    LLMAuthError,
    LLMInvalidResponseError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMUpstreamError,
)
from agentcore.llm.background_failure import classify_background_llm_failure


def test_classify_auth():
    assert classify_background_llm_failure(LLMAuthError()) == "auth"


def test_classify_rate_limit():
    assert classify_background_llm_failure(LLMRateLimitError()) == "rate_limit"


def test_classify_timeout():
    assert classify_background_llm_failure(TimeoutError()) == "timeout"
    assert classify_background_llm_failure(LLMTimeoutError("t")) == "timeout"


def test_classify_upstream():
    assert (
        classify_background_llm_failure(LLMUpstreamError("503", upstream_status=503))
        == "upstream_unstable"
    )


def test_classify_provider_unavailable_message():
    assert (
        classify_background_llm_failure(RuntimeError("background credentials unavailable"))
        == "provider_unavailable"
    )


def test_classify_invalid_response():
    assert (
        classify_background_llm_failure(LLMInvalidResponseError("gateway login html"))
        == "invalid_response"
    )


def test_classify_other():
    assert classify_background_llm_failure(RuntimeError("network down")) == "other"
    # Plain LLMError (no typed subclass) stays in other — do not scan message text.
    from agentcore.core.errors import LLMError

    assert classify_background_llm_failure(LLMError("响应格式无效")) == "other"


def test_only_a_stated_cooldown_dates_a_recovery():
    """出处决定这个数算不算「上游说的」——不是 ``retryable``，也不是它有多大。

    三种出处走同一条给放弃路径：真头、我们自己的退避、跨 hop 转述来的裸数字。后两种
    在异常上长得和第一种一模一样（不可重试 + 带 ``retry_after``），一旦被当成声明，
    下游就会照着一个上游从没说过的时刻安排冷却。
    """
    from agentcore.core.errors import (
        RETRY_AFTER_FROM_BACKOFF,
        RETRY_AFTER_FROM_HEADER,
        upstream_rate_limit_error,
    )
    from agentcore.llm.background_failure import declared_recovery_seconds

    def _429(source: str | None = None):
        kwargs = {"retry_after_source": source} if source else {}
        return upstream_rate_limit_error(
            46_440, credential_source="user", retry_ceiling=40, **kwargs
        )

    assert declared_recovery_seconds(_429(RETRY_AFTER_FROM_HEADER)) == 46_440
    # 我们自己退避链的末项；以及 /inference/ hop 转述来的、两头都无从作证的那个数。
    assert declared_recovery_seconds(_429(RETRY_AFTER_FROM_BACKOFF)) is None
    assert declared_recovery_seconds(_429()) is None


def test_the_quota_face_keeps_its_provenance_across_the_gate():
    """平台代付撞日级 429 会换上额度墙那张脸——出处必须跟着一起换过去。

    ``run_background_llm`` 只在这张脸上读恢复时刻，压缩与记忆两条冷却链都吃它。出处
    掉在换脸那一步，真声明也会当场消失，两边退回纯猜测。
    """
    from agentcore.core.errors import (
        RETRY_AFTER_FROM_HEADER,
        LLMQuotaExceededError,
        upstream_rate_limit_error,
    )
    from agentcore.llm.background_failure import declared_recovery_seconds

    wall = upstream_rate_limit_error(
        46_440,
        credential_source="platform",
        retry_ceiling=40,
        retry_after_source=RETRY_AFTER_FROM_HEADER,
    )
    assert isinstance(wall, LLMQuotaExceededError)
    # 这个数只在 details 里，出处只在属性上——两处都读到才有日期。
    assert declared_recovery_seconds(wall) == 46_440
    assert "retry_after_source" not in wall.details

    # 配额窗口那张脸（billing.call_quota）自己就没报过时刻，照旧不许编一个。
    window = LLMQuotaExceededError(reset_at="2026-08-15T00:00:00Z")
    assert declared_recovery_seconds(window) is None


def test_balance_exhaustion_is_not_broken_config():
    """An upstream out of credit must not flag the user's provider as misconfigured.

    Upstreams that answer 401 for an empty balance (OpenCode Zen) used to land on
    ``LLMAuthError`` and mark ``status=error``, hiding a provider whose key is fine.
    """
    from agentcore.core.errors import LLMInsufficientBalanceError
    from agentcore.llm.background_failure import is_config_shaped_background_failure

    exhausted = LLMInsufficientBalanceError(upstream_status=401)
    assert is_config_shaped_background_failure(exhausted) is False
    assert is_config_shaped_background_failure(LLMAuthError()) is True
