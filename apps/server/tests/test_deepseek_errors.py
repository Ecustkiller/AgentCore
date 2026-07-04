"""Provider-level mapping of upstream DeepSeek HTTP errors raised during a turn.

402 Insufficient Balance is the interesting case: a *valid* key whose account has
run dry. Unlike a missing key (refused at the route preflight before the stream
opens — tests/integration/test_llm_key_api.py), it surfaces mid-turn from
``complete()`` / ``stream()``, so the provider must map it to a non-retryable
``LLMInsufficientBalanceError`` with a friendly "top up" message instead of leaking
a raw ``httpx.HTTPStatusError``. Network is mocked via ``httpx.MockTransport``.
"""

import httpx
import pytest

from agentcore.core.errors import (
    LLMAuthError,
    LLMInsufficientBalanceError,
    LLMUpstreamError,
)
from agentcore.llm.config import DEEPSEEK_V4_FLASH
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.protocol import LLMMessage, LLMRequest


async def _mock_provider(handler) -> DeepSeekProvider:
    """A provider whose HTTP client is backed by a MockTransport (no network).

    The real client built in ``__init__`` is closed first so it never leaks.
    """
    provider = DeepSeekProvider(api_key="k", base_url="http://example.invalid")
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="http://example.invalid",
        transport=httpx.MockTransport(handler),
    )
    return provider


def _req() -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
    )


async def test_complete_maps_402_to_insufficient_balance():
    provider = await _mock_provider(lambda request: httpx.Response(402))
    try:
        with pytest.raises(LLMInsufficientBalanceError) as ei:
            await provider.complete(_req())
        assert "余额" in str(ei.value)
    finally:
        await provider.close()


async def test_stream_maps_402_to_insufficient_balance():
    provider = await _mock_provider(lambda request: httpx.Response(402))
    try:
        with pytest.raises(LLMInsufficientBalanceError):
            async for _ in provider.stream(_req()):
                pass
    finally:
        await provider.close()


@pytest.mark.parametrize("code", [401, 403])
async def test_complete_maps_401_403_to_auth_error(code):
    provider = await _mock_provider(lambda request: httpx.Response(code))
    try:
        with pytest.raises(LLMAuthError) as ei:
            await provider.complete(_req())
        assert "Key" in str(ei.value)
    finally:
        await provider.close()


@pytest.mark.parametrize("code", [401, 403])
async def test_stream_maps_401_403_to_auth_error(code):
    provider = await _mock_provider(lambda request: httpx.Response(code))
    try:
        with pytest.raises(LLMAuthError):
            async for _ in provider.stream(_req()):
                pass
    finally:
        await provider.close()


@pytest.mark.parametrize("code", [500, 502, 503])
async def test_complete_retries_5xx_then_raises(code):
    call_count = 0

    def handler(request):
        nonlocal call_count
        call_count += 1
        return httpx.Response(code)

    provider = await _mock_provider(handler)
    try:
        with pytest.raises(LLMUpstreamError) as ei:
            await provider.complete(_req())
        msg = str(ei.value)
        assert "DeepSeek" in msg and str(code) in msg
        assert call_count == 3  # retried _MAX_RETRIES times
    finally:
        await provider.close()


async def test_stream_retries_5xx_then_raises():
    call_count = 0

    def handler(request):
        nonlocal call_count
        call_count += 1
        return httpx.Response(503)

    provider = await _mock_provider(handler)
    try:
        with pytest.raises(LLMUpstreamError) as ei:
            async for _ in provider.stream(_req()):
                pass
        assert "DeepSeek" in str(ei.value)
        assert call_count == 3
    finally:
        await provider.close()


def test_balance_and_auth_errors_are_not_retryable():
    # The retry loop in deepseek.py re-raises immediately when `retryable` is False,
    # so these must never spin the backoff loop (they would just re-fail).
    assert LLMInsufficientBalanceError().retryable is False
    assert LLMInsufficientBalanceError().code == "LLM_INSUFFICIENT_BALANCE"
    assert LLMAuthError().retryable is False
    assert LLMAuthError().code == "LLM_KEY_INVALID"


def test_upstream_error_is_retryable():
    err = LLMUpstreamError("test")
    assert err.retryable is True
    assert err.code == "LLM_ERROR"
