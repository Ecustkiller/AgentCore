"""流式停滞闸 (stall gate): a stalled LLM stream must fail FAST + observably instead of
freezing the whole turn (the 辩论回合卡死 root cause).

Pins ``stream_llm_round``'s per-chunk IDLE ceiling:
- a post-commit stall (content already streamed) returns ``aborted`` with the partial
  kept — same salvage contract as a mid-stream disconnect;
- a pre-commit stall (no content / tool_call yet) raises ``LLMTimeoutError``;
- a healthy trickle (gaps < idle) completes normally regardless of TOTAL duration;
- disabling the gate (0) never trips.
"""

import asyncio

import pytest

from agentcore.config import settings
from agentcore.core.errors import LLMTimeoutError
from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, LLMRequest
from agentcore.runtime.engine.stream import stream_llm_round


def _request() -> LLMRequest:
    return LLMRequest(messages=[LLMMessage(role="user", content="hi")], model="m")


class _StallProvider:
    """Yields ``pre`` chunks, then goes silent (sleeps) past the idle ceiling."""

    def __init__(self, pre: list[LLMChunk], stall: float) -> None:
        self._pre = pre
        self._stall = stall

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        for chunk in self._pre:
            yield chunk
        await asyncio.sleep(self._stall)  # no further chunk within the idle window
        yield LLMChunk(delta_content="late")


class _TrickleProvider:
    """Yields chunks with a gap SHORTER than the ceiling — a healthy long stream."""

    def __init__(self, n: int, gap: float) -> None:
        self._n = n
        self._gap = gap

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        for i in range(self._n):
            await asyncio.sleep(self._gap)
            yield LLMChunk(delta_content=str(i))


async def test_committed_stall_returns_aborted_partial(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.05)
    seen: list[str] = []
    provider = _StallProvider([LLMChunk(delta_content="thinking…")], stall=1.0)
    result = await stream_llm_round(provider, _request(), seen.append, lambda _d: None)
    assert result.aborted is True
    assert result.content == "thinking…"
    assert seen == ["thinking…"]


async def test_uncommitted_stall_raises_timeout(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.05)
    seen: list[str] = []
    provider = _StallProvider([LLMChunk(delta_reasoning="…")], stall=1.0)
    with pytest.raises(LLMTimeoutError):
        await stream_llm_round(provider, _request(), seen.append, seen.append)
    assert seen == ["…"]


async def test_healthy_trickle_completes(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.2)
    seen: list[str] = []
    provider = _TrickleProvider(n=4, gap=0.02)  # each gap well under the 0.2s ceiling
    result = await stream_llm_round(provider, _request(), seen.append, lambda _d: None)
    assert result.content == "0123"
    assert seen == ["0", "1", "2", "3"]
    assert result.tool_calls is None
    assert result.aborted is False


async def test_gate_disabled_never_trips(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.0)
    seen: list[str] = []
    provider = _StallProvider([LLMChunk(delta_content="x")], stall=0.1)
    # Gate off (asyncio.timeout(None)) ⇒ the stall is tolerated; bound the test so a
    # regression that re-enables an idle abort here would surface as a raise, not a hang.
    result = await asyncio.wait_for(
        stream_llm_round(provider, _request(), seen.append, lambda _d: None), timeout=2.0
    )
    assert result.content == "xlate"


class _ResetThenContentProvider:
    """Emits ephemeral reasoning, then stream_reset, then fresh content."""

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        yield LLMChunk(delta_reasoning="stale")
        yield LLMChunk(stream_reset=True)
        yield LLMChunk(delta_content="kept")


async def test_stream_reset_clears_ephemeral_and_live_view(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.0)
    content_seen: list[str] = []
    reasoning_seen: list[str] = []
    resets: list[int] = []
    result = await stream_llm_round(
        _ResetThenContentProvider(),
        _request(),
        content_seen.append,
        reasoning_seen.append,
        on_reset=lambda: resets.append(1),
    )
    assert reasoning_seen == ["stale"]
    assert content_seen == ["kept"]
    assert result.content == "kept"
    assert result.reasoning == ""
    assert resets == [1]
