"""Provider-level mapping of upstream HTTP errors raised during a turn."""

import httpx
import pytest

from agentcore.core.errors import (
    LLMAuthError,
    LLMInsufficientBalanceError,
    LLMUpstreamError,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest


async def _mock_provider(handler) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(
        name="test", api_key="k", base_url="http://example.invalid/v1"
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="http://example.invalid/v1",
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
        with pytest.raises(LLMAuthError):
            await provider.complete(_req())
    finally:
        await provider.close()


async def test_complete_maps_500_with_context():
    provider = await _mock_provider(
        lambda request: httpx.Response(500, content=b'{"error":"boom"}')
    )
    try:
        with pytest.raises(LLMUpstreamError) as ei:
            await provider.complete(_req())
        assert ei.value.details.get("upstream_status") == 500
        assert "boom" in (ei.value.details.get("upstream_body_preview") or "")
    finally:
        await provider.close()


def test_balance_and_auth_errors_are_not_retryable():
    assert LLMInsufficientBalanceError().retryable is False
    assert LLMAuthError().retryable is False


def test_upstream_error_is_retryable():
    err = LLMUpstreamError("test", upstream_status=502)
    assert err.retryable is True
