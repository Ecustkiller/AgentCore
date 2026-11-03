"""First-byte deadline: the wait before a stream's first token, on its own clock.

Two waits live inside one streamed call — before the first token, and between
tokens — and the origin-pooled client's 300s read timeout covers both with one
number. These tests pin the short one: it must fire on silence before the first
payload, must not fire once the model has started, and must not reuse the
network-failure copy when it does.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import AsyncIterator

import httpx
import pytest

from agentcore.core.errors import LLMTimeoutError
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider.first_byte import (
    DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS,
    FirstByteTimeoutError,
    anthropic_payload_line,
    first_byte_timeout_seconds,
    lines_until_first_byte,
    openai_chat_payload_line,
)
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest

_CHAT_DELTA = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
_ROLE_ONLY = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'


async def _source(lines: tuple[str, ...], *, tail_stall: float = 0.0) -> AsyncIterator[str]:
    for line in lines:
        yield line
    if tail_stall:
        await asyncio.sleep(tail_stall)


# ---- budget knob --------------------------------------------------------------


def test_gate_ships_off_and_env_opts_in(monkeypatch):
    """The engine's calibrated idle gate owns the default; this is opt-in."""
    monkeypatch.delenv("AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS", raising=False)
    assert DEFAULT_FIRST_BYTE_TIMEOUT_SECONDS is None
    assert first_byte_timeout_seconds() is None

    monkeypatch.setenv("AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS", "12.5")
    assert first_byte_timeout_seconds() == 12.5

    # Zero / negative is the explicit off switch, not an instant timeout.
    for off in ("0", "-1"):
        monkeypatch.setenv("AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS", off)
        assert first_byte_timeout_seconds() is None

    monkeypatch.setenv("AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS", "not-a-number")
    assert first_byte_timeout_seconds() is None


# ---- guard --------------------------------------------------------------------


async def test_guard_is_a_passthrough_when_the_budget_is_off():
    seen = [
        line
        async for line in lines_until_first_byte(
            _source(("a", "b")),
            budget_seconds=None,
            started_at=time.monotonic(),
            is_payload=openai_chat_payload_line,
        )
    ]
    assert seen == ["a", "b"]


async def test_guard_raises_when_the_source_never_speaks():
    with pytest.raises(FirstByteTimeoutError) as exc:
        async for _ in lines_until_first_byte(
            _source((), tail_stall=5.0),
            budget_seconds=0.05,
            started_at=time.monotonic(),
            is_payload=openai_chat_payload_line,
        ):
            pass
    assert exc.value.seconds == 0.05


async def test_role_only_heartbeats_do_not_count_as_a_first_byte():
    """A stream that says "assistant" and then stalls has produced no answer."""
    with pytest.raises(FirstByteTimeoutError):
        async for _ in lines_until_first_byte(
            _source((_ROLE_ONLY, _ROLE_ONLY), tail_stall=5.0),
            budget_seconds=0.05,
            started_at=time.monotonic(),
            is_payload=openai_chat_payload_line,
        ):
            pass


async def test_guard_stops_applying_once_the_model_has_started():
    """After the first payload the long idle ceiling owns the stream, not this."""
    seen: list[str] = []
    async for line in lines_until_first_byte(
        _source((_ROLE_ONLY, _CHAT_DELTA, "data: [DONE]"), tail_stall=0.15),
        budget_seconds=0.05,
        started_at=time.monotonic(),
        is_payload=openai_chat_payload_line,
    ):
        seen.append(line)
    assert seen == [_ROLE_ONLY, _CHAT_DELTA, "data: [DONE]"]


# ---- wire predicates ----------------------------------------------------------


def test_openai_predicate_ignores_heartbeats_and_done():
    assert openai_chat_payload_line(_CHAT_DELTA) is True
    assert openai_chat_payload_line(_ROLE_ONLY) is False
    assert openai_chat_payload_line('data: {"choices":[{"delta":{}}]}') is False
    assert openai_chat_payload_line("data: [DONE]") is False
    assert openai_chat_payload_line(": keep-alive") is False
    assert openai_chat_payload_line("data: not-json") is False
    assert (
        openai_chat_payload_line(
            'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}'
        )
        is True
    )
    assert (
        openai_chat_payload_line(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}'
        )
        is True
    )


def test_anthropic_predicate_needs_a_content_block():
    assert (
        anthropic_payload_line('data: {"type":"content_block_delta","delta":{}}') is True
    )
    assert anthropic_payload_line('data: {"type":"content_block_start"}') is True
    assert anthropic_payload_line('data: {"type":"message_start"}') is False
    assert anthropic_payload_line('data: {"type":"ping"}') is False
    assert anthropic_payload_line("event: message_start") is False


# ---- leaf wiring --------------------------------------------------------------


class _StallingStream(httpx.AsyncByteStream):
    """Opens, sends a role-only frame, then goes quiet mid-stream."""

    async def __aiter__(self):
        yield _ROLE_ONLY.encode()
        await asyncio.sleep(30.0)


async def _mock_provider(handler) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(
        name="user", api_key="k", base_url="http://example.invalid/v1"
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="http://example.invalid/v1",
        transport=httpx.MockTransport(handler),
    )
    return provider


async def test_leaf_reports_first_byte_silence_without_blaming_the_network(monkeypatch):
    monkeypatch.setenv("AGENTCORE_LLM_FIRST_BYTE_TIMEOUT_SECONDS", "0.05")
    provider = await _mock_provider(
        lambda request: httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_StallingStream(),
        )
    )

    async def _no_sleep(
        *, attempt, backoff, stream, reason, partial_sse_lines=0, max_attempts=None
    ):
        return backoff

    provider._sleep_before_retry = _no_sleep  # type: ignore[method-assign]
    request = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=DEEPSEEK_V4_FLASH,
        scenario="chat",
    )

    with pytest.raises(LLMTimeoutError) as exc:
        async for _ in provider.stream(request):
            pass
    message = str(exc.value)
    assert "没有返回任何内容" in message
    # The connection was fine — the network copy would be a false diagnosis.
    assert "检查网络" not in message
    await provider.close()
