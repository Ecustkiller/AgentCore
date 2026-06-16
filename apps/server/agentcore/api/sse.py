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
    sink: EventSink, producer: asyncio.Task | None
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
        # The client disconnected before the stream finished (e.g. the user hit
        # "stop", which aborts the fetch). Cancel the detached producer so it
        # stops burning tokens for a response nobody will read. Normal
        # completion (sink closed by the pipeline) skips this branch, leaving
        # any post-stream work — title/memory — to finish in the background.
        if producer is not None and not producer.done():
            producer.cancel()
        raise


def sse_response(
    sink: EventSink, *, producer: asyncio.Task | None = None
) -> StreamingResponse:
    """Create a StreamingResponse that consumes an EventSink.

    ``producer`` is the background task feeding the sink. When provided, it is
    cancelled if the client disconnects mid-stream, so server-side generation
    stops together with the client instead of running on detached.
    """
    return StreamingResponse(
        _event_generator(sink, producer),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
