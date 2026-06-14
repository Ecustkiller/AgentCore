"""SSE StreamingResponse wrapper.

Consumes an EventSink and serializes events as text/event-stream lines.
"""

import asyncio
import json
from collections.abc import AsyncIterator

from starlette.responses import StreamingResponse

from agentcore.runtime.events import EventSink, SSEEvent


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
        async for event in sink:
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
