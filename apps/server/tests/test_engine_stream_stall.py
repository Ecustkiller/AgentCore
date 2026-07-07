"""流式停滞闸 (stall gate): a stalled LLM stream must fail FAST + observably instead of
freezing the whole turn (the 辩论回合卡死 root cause).

Pins ``stream_llm_round``'s per-chunk IDLE ceiling:
- a stall (no chunk for > idle) raises ``LLMTimeoutError`` — and the pre-stall content
  that already streamed to the client is preserved on the way out (emitted, not lost);
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


async def test_stall_raises_timeout_and_preserves_streamed_prefix(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.05)
    seen: list[str] = []
    provider = _StallProvider([LLMChunk(delta_content="thinking…")], stall=1.0)
    with pytest.raises(LLMTimeoutError):
        await stream_llm_round(provider, _request(), seen.append, lambda _d: None)
    # the pre-stall delta DID reach the client before the gate tripped — the freeze is
    # cut short, not the content that already made it out.
    assert seen == ["thinking…"]


async def test_healthy_trickle_completes(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.2)
    seen: list[str] = []
    provider = _TrickleProvider(n=4, gap=0.02)  # each gap well under the 0.2s ceiling
    content, reasoning, tool_calls, _usage, _diag, _preview = await stream_llm_round(
        provider, _request(), seen.append, lambda _d: None
    )
    assert content == "0123"
    assert seen == ["0", "1", "2", "3"]
    assert tool_calls is None


async def test_gate_disabled_never_trips(monkeypatch):
    monkeypatch.setattr(settings, "engine_llm_stream_idle_timeout_seconds", 0.0)
    seen: list[str] = []
    provider = _StallProvider([LLMChunk(delta_content="x")], stall=0.1)
    # Gate off (asyncio.timeout(None)) ⇒ the stall is tolerated; bound the test so a
    # regression that re-enables an idle abort here would surface as a raise, not a hang.
    content, _r, _tc, _u, _diag, _preview = await asyncio.wait_for(
        stream_llm_round(provider, _request(), seen.append, lambda _d: None), timeout=2.0
    )
    assert content == "xlate"
