"""SSE StreamingResponse wrapper.

Consumes an EventSink and serializes events as text/event-stream lines.
"""

import asyncio
import json
from collections.abc import AsyncIterator

from starlette.responses import StreamingResponse

from agentcore.runtime.events import EventSink, SSEEvent

# Idle keep-alive cadence. When the producer is mid-thought (no events queued),
# the generator emits a comment frame this often so the connection keeps flowing
# bytes; the client's stall watchdog uses those bytes to tell "still working"
# from "dead stream". Must stay well under the client idle timeout (see
# streamConversation.ts) so a slow-but-alive turn is never mistaken for a drop.
_HEARTBEAT_INTERVAL_S = 15.0


def _format_sse(event: SSEEvent) -> str:
    data = json.dumps(
        {"type": event.type, "timestamp": event.timestamp, "payload": event.payload},
        ensure_ascii=False,
    )
    return f"event: {event.type}\ndata: {data}\n\n"


async def _event_generator(
    sink: EventSink,
    producer: asyncio.Task | None,
    *,
    detach_on_disconnect: bool = False,
) -> AsyncIterator[str]:
    try:
        while True:
            try:
                event = await asyncio.wait_for(sink.get(), _HEARTBEAT_INTERVAL_S)
            except TimeoutError:
                # No event for a while — the turn is alive but thinking. Emit an
                # SSE comment line (begins with ':'): the client ignores it at the
                # parse layer but counts the bytes as liveness, so its watchdog
                # holds. Cancelling the queue.get() here is loss-safe on 3.12.
                yield ": ping\n\n"
                continue
            if event is None:
                break
            yield _format_sse(event)
    except (asyncio.CancelledError, GeneratorExit):
        # The client disconnected before the stream finished. Two policies:
        #
        # - detach_on_disconnect (chat turns, 执行与请求解耦 C1 · slice 1a): the run
        #   is detached + tracked in the TurnRunRegistry, so a dropped connection
        #   must NOT kill it (案例 1: 断连即丢交付). Detach the sink so the unread
        #   queue stops growing; the run finishes + persists in the background, and
        #   an explicit 停止 routes through POST .../stop instead.
        # - else (handoff archive/dispatch/apply SSEs): cancel the producer so it
        #   stops burning work for a response nobody will read.
        #
        # Normal completion (sink closed by the pipeline) skips this branch.
        if detach_on_disconnect:
            sink.detach()
        elif producer is not None and not producer.done():
            producer.cancel()
        raise


def sse_response(
    sink: EventSink,
    *,
    producer: asyncio.Task | None = None,
    detach_on_disconnect: bool = False,
) -> StreamingResponse:
    """Create a StreamingResponse that consumes an EventSink.

    Two client-disconnect policies (mutually exclusive):

    - ``producer`` (default): the background task feeding the sink is cancelled when
      the client disconnects, so generation stops together with the client. Used by
      the short handoff SSEs.
    - ``detach_on_disconnect=True``: the run is decoupled from the request (执行与请求
      解耦 C1 · slice 1a) — a disconnect only detaches the sink and the run keeps
      going + persists in the background; cancellation is done explicitly via the
      stop endpoint. Used by the chat-turn SSEs (send / regenerate / resume), which
      register their task in the ``TurnRunRegistry`` instead of passing it here.
    """
    return StreamingResponse(
        _event_generator(sink, producer, detach_on_disconnect=detach_on_disconnect),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _attach_generator(sink: EventSink) -> AsyncIterator[str]:
    """Replay a running turn's transcript, then tail it live (实时重连续看, C1 · 1b).

    Used by the attach endpoint when a client re-connects to a still-running detached
    run. ``take_over`` (synchronous) hands us the replay snapshot and re-arms the SSE
    queue; we flush the snapshot, then drain new events exactly like the primary
    generator (same heartbeat, same disconnect policy). Because the run is detached,
    a disconnect here just detaches again — it never cancels the turn.
    """
    replay = sink.take_over()
    try:
        for event in replay:
            yield _format_sse(event)
        while True:
            try:
                event = await asyncio.wait_for(sink.get(), _HEARTBEAT_INTERVAL_S)
            except TimeoutError:
                yield ": ping\n\n"
                continue
            if event is None:
                break
            yield _format_sse(event)
    except (asyncio.CancelledError, GeneratorExit):
        sink.detach()
        raise


def sse_attach_response(sink: EventSink) -> StreamingResponse:
    """Stream a re-attaching client the replay-then-tail of a live detached run (1b).

    The run keeps executing independently (执行与请求解耦); this is a pure observer that
    replays what the client missed and follows along, so dropping it again is harmless
    (detach, never cancel — an explicit 停止 still goes through ``POST .../stop``).
    """
    return StreamingResponse(
        _attach_generator(sink),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
