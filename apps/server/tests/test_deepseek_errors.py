"""Provider-level mapping of upstream HTTP errors raised during a turn."""

import httpx
import pytest

from agentcore.core.errors import (
    LLMAuthError,
    LLMError,
    LLMInsufficientBalanceError,
    LLMUpstreamError,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest, ToolCall, ToolCallFunction


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


async def test_complete_maps_400_to_llm_error_with_upstream_body():
    body = (
        b'{"error":{"message":"The `reasoning_content` in the thinking mode '
        b'must be passed back to the API."}}'
    )
    provider = await _mock_provider(lambda request: httpx.Response(400, content=body))
    try:
        with pytest.raises(LLMError) as ei:
            await provider.complete(_req())
        assert ei.value.retryable is False
        assert "reasoning_content" in ei.value.message
        assert ei.value.details.get("upstream_status") == 400
        assert "reasoning_content" in (ei.value.details.get("upstream_body_preview") or "")
    finally:
        await provider.close()


async def test_stream_maps_400_to_llm_error():
    body = b'{"error":{"message":"bad request"}}'
    provider = await _mock_provider(lambda request: httpx.Response(400, content=body))
    try:
        with pytest.raises(LLMError) as ei:
            async for _ in provider.stream(_req()):
                pass
        assert "bad request" in ei.value.message
    finally:
        await provider.close()


def test_build_payload_echoes_reasoning_content_for_tool_turns():
    provider = OpenAICompatibleProvider(name="test", api_key="k", base_url="http://x/v1")
    req = LLMRequest(
        messages=[
            LLMMessage(role="user", content="go"),
            LLMMessage(
                role="assistant",
                content="",
                reasoning_content="chain",
                tool_calls=[
                    ToolCall(
                        id="tc1",
                        function=ToolCallFunction(name="search", arguments="{}"),
                    )
                ],
            ),
            LLMMessage(
                role="assistant",
                content="",
                tool_calls=[
                    ToolCall(
                        id="tc2",
                        function=ToolCallFunction(name="read", arguments="{}"),
                    )
                ],
            ),
        ],
        model=DEEPSEEK_V4_FLASH,
    )
    payload = provider._build_payload(req, stream=True)
    assistant_msgs = [m for m in payload["messages"] if m["role"] == "assistant"]
    assert assistant_msgs[0]["reasoning_content"] == "chain"
    assert assistant_msgs[1]["reasoning_content"] == ""


def test_build_payload_disables_thinking_for_deepseek_v4_background():
    """Title/memory one-shots must send thinking.disabled — otherwise V4's default
    thinking eats a tight max_tokens budget and the sidebar falls back to raw input."""
    provider = OpenAICompatibleProvider(name="test", api_key="k", base_url="http://x/v1")
    req = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
        max_tokens=64,
        thinking=False,
        scenario="title",
    )
    payload = provider._build_payload(req, stream=False)
    assert payload["thinking"] == {"type": "disabled"}

    # Non-DeepSeek models must not get the DeepSeek-only field.
    other = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="gpt-4o",
        thinking=False,
        scenario="title",
    )
    assert "thinking" not in provider._build_payload(other, stream=False)

    # Default (None) leaves thinking omitted so V4 keeps its enabled default.
    default = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
    )
    assert "thinking" not in provider._build_payload(default, stream=False)


def test_balance_and_auth_errors_are_not_retryable():
    assert LLMInsufficientBalanceError().retryable is False
    assert LLMAuthError().retryable is False


def test_upstream_error_is_retryable():
    err = LLMUpstreamError("test", upstream_status=502)
    assert err.retryable is True
