"""SSE generator: idle heartbeat + event passthrough + optional id: seq.

The live-tail races a persistent ``sink.get`` task against a heartbeat timeout
(``asyncio.wait``, never ``wait_for``) so a turn that is alive but thinking keeps
the connection flowing bytes without cancelling a get that may already hold a
dequeued event behind the persist barrier. No DB, no HTTP — plain async tests
(asyncio_mode=auto).
"""

import asyncio
import json

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
        # Nothing queued → the wait times out → an SSE comment heartbeat frame;
        # the underlying get task stays alive across the ping.
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


async def test_heartbeat_does_not_cancel_get_waiting_on_persist_barrier(monkeypatch):
    """SS-1: heartbeat timeout must not cancel ``sink.get`` mid persist barrier.

    If the get has already dequeued the event and is awaiting the barrier,
    cancelling it (as ``wait_for`` would) drops the event and desyncs
    queue/barrier pairing. Persistent get + ``asyncio.wait`` must ping while
    still delivering the event once the barrier resolves.
    """
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.02)
    sink = EventSink()
    loop = asyncio.get_running_loop()
    barrier: asyncio.Future[int | None] = loop.create_future()
    sink._queue.put_nowait(content_delta("held"))
    sink._persist_barriers.put_nowait(barrier)

    gen = sse._event_generator(sink, None)
    try:
        ping = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert ping.startswith(":")

        barrier.set_result(99)
        frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "content_delta" in frame
        assert "\nid: 99\n" in frame

        sink.close()
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    finally:
        if not barrier.done():
            barrier.cancel()
        await gen.aclose()


def test_format_sse_optional_id_line():
    event = content_delta("partial")
    plain = sse._format_sse(event)
    assert "id:" not in plain
    assert plain.startswith(f"event: {event.type}")
    assert "\ndata: " in plain

    with_id = sse._format_sse(event, seq=42)
    assert "\nid: 42\n" in with_id
    # Envelope JSON unchanged — id is a transport line, not a payload field.
    data_line = next(line for line in with_id.split("\n") if line.startswith("data: "))
    envelope = json.loads(data_line[len("data: ") :])
    assert set(envelope) == {"type", "timestamp", "payload"}
    assert "id" not in envelope


def test_pump_sse_style_parser_ignores_id_lines():
    """Mirrors desktop/mobile pumpSSE: only ``data:`` lines are parsed."""
    frame = sse._format_sse(content_delta("hi"), seq=7)
    events = []
    for line in frame.split("\n"):
        if not line.startswith("data: "):
            continue
        events.append(json.loads(line[len("data: ") :]))
    assert len(events) == 1
    assert events[0]["type"] == "content_delta"
    assert events[0]["payload"] == {"delta": "hi"}
