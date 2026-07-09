"""LLM provider retry policy: transient upstream / transport failures."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from agentcore.core.errors import LLMError, LLMUpstreamError
from agentcore.llm.errors import is_non_retryable_client_status, is_retryable_upstream_status
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.openai_compatible import (
    _INITIAL_BACKOFF,
    _MAX_RETRIES,
    OpenAICompatibleProvider,
)
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest


def _ok_body() -> dict:
    return {
        "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        "model": DEEPSEEK_V4_FLASH,
    }


def _sse_line(text: str = "hi") -> str:
    payload = {
        "choices": [{"delta": {"content": text}, "finish_reason": None}],
    }
    return f"data: {json.dumps(payload)}\n"


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


def test_retryable_status_helpers():
    assert is_retryable_upstream_status(502) is True
    assert is_retryable_upstream_status(503) is True
    assert is_retryable_upstream_status(400) is False
    assert is_non_retryable_client_status(400) is True
    assert is_non_retryable_client_status(401) is True
    assert is_non_retryable_client_status(502) is False


@pytest.mark.parametrize("code", [502, 503])
async def test_complete_retries_transient_5xx_then_succeeds(code, monkeypatch):
    calls = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(code, content=b'{"error":"upstream"}')
        return httpx.Response(200, json=_ok_body())

    provider = await _mock_provider(handler)
    try:
        result = await provider.complete(_req())
        assert result.content == "ok"
        assert calls["n"] == 2
        assert sleeps == [_INITIAL_BACKOFF]
    finally:
        await provider.close()


async def test_complete_does_not_retry_400(monkeypatch):
    calls = {"n": 0}

    async def fake_sleep(sec: float) -> None:
        raise AssertionError("should not sleep on 400")

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(400, content=b'{"error":{"message":"bad request"}}')

    provider = await _mock_provider(handler)
    try:
        with pytest.raises(LLMError) as ei:
            await provider.complete(_req())
        assert ei.value.retryable is False
        assert calls["n"] == 1
    finally:
        await provider.close()


async def test_complete_retries_connect_error_then_succeeds(monkeypatch):
    calls = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            raise httpx.ConnectError("connection reset")
        return httpx.Response(200, json=_ok_body())

    provider = await _mock_provider(handler)
    try:
        result = await provider.complete(_req())
        assert result.content == "ok"
        assert calls["n"] == 2
        assert sleeps == [_INITIAL_BACKOFF]
    finally:
        await provider.close()


async def test_complete_exhausts_retries_on_persistent_502(monkeypatch):
    calls = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(502, content=b'{"error":"bad gateway"}')

    provider = await _mock_provider(handler)
    try:
        with pytest.raises(LLMUpstreamError) as ei:
            await provider.complete(_req())
        assert calls["n"] == _MAX_RETRIES
        assert sleeps == [_INITIAL_BACKOFF, _INITIAL_BACKOFF * 2]
        assert ei.value.details.get("retry_attempts") == _MAX_RETRIES
    finally:
        await provider.close()


async def test_stream_retries_502_before_any_sse_line(monkeypatch):
    calls = {"n": 0}
    sleeps: list[float] = []

    async def fake_sleep(sec: float) -> None:
        sleeps.append(sec)

    monkeypatch.setattr("agentcore.llm.provider.openai_compatible.asyncio.sleep", fake_sleep)

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] == 1:
            return httpx.Response(502, content=b'{"error":"bad gateway"}')
        body = _sse_line("done") + "data: [DONE]\n"
        return httpx.Response(200, content=body.encode())

    provider = await _mock_provider(handler)
    try:
        lines = [line async for line in provider._stream_with_retry({"model": "x"})]
        assert any("done" in line for line in lines)
        assert calls["n"] == 2
        assert sleeps == [_INITIAL_BACKOFF]
    finally:
        await provider.close()


async def test_stream_does_not_retry_after_partial_sse_lines():
    provider = OpenAICompatibleProvider(
        name="test", api_key="k", base_url="http://example.invalid/v1"
    )

    async def line_iter():
        yield _sse_line("partial")
        raise httpx.ReadError("peer closed connection")

    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.headers = {}
    mock_response.aread = AsyncMock(return_value=b"")
    mock_response.aiter_lines = line_iter
    mock_response.__aenter__ = AsyncMock(return_value=mock_response)
    mock_response.__aexit__ = AsyncMock(return_value=False)

    provider._client.stream = MagicMock(return_value=mock_response)
    try:
        collected: list[str] = []
        with pytest.raises(LLMUpstreamError):
            async for line in provider._stream_with_retry({"model": "x"}):
                collected.append(line)
        assert collected == [_sse_line("partial")]
        provider._client.stream.assert_called_once()
    finally:
        await provider.close()
