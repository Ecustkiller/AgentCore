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
