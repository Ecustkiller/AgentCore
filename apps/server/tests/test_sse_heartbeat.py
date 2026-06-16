"""SSE generator: idle heartbeat + event passthrough.

The generator races each event pull against a heartbeat timeout so a turn that is
alive but thinking keeps the connection flowing bytes (the client's stall watchdog
reads those bytes as liveness). No DB, no HTTP — plain async tests
(asyncio_mode=auto).
"""

import asyncio

import pytest

from agentcore.api import sse
from agentcore.runtime.events import EventSink, content_delta


async def test_forwards_events_then_ends_on_close():
    sink = EventSink()
    sink.emit(content_delta("hi"))
    sink.close()

    frames = [frame async for frame in sse._event_generator(sink, None)]

    # The content event is serialized and delivered; nothing idled, so no
    # heartbeat comment is interleaved.
    assert any("content_delta" in f for f in frames)
    assert all(not f.startswith(":") for f in frames)


async def test_emits_heartbeat_while_idle(monkeypatch):
    # Shrink the cadence so the idle branch fires fast and deterministically.
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.02)
    sink = EventSink()
    gen = sse._event_generator(sink, None)
    try:
        # Nothing queued → the pull times out → an SSE comment heartbeat frame.
        first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert first.startswith(":")

        # Real events still come through after heartbeats.
        sink.emit(content_delta("hi"))
        second = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "content_delta" in second

        # Closing the sink ends the stream.
        sink.close()
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    finally:
        await gen.aclose()
