"""SSE StreamingResponse wrapper.

Consumes an EventSink and serializes events as text/event-stream lines.
Also hosts the shared pre-stream DB release so long-lived SSE routes do not
pin a pooled primary connection for the whole stream lifetime.
"""

import asyncio
import json
from collections import deque
from collections.abc import AsyncIterator
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from agentcore.runtime.events import (
    ConversationWatcher,
    EventSink,
    SinkSubscription,
    SSEEvent,
    conversation_streams,
)


async def release_request_db_before_sse(session: AsyncSession) -> None:
    """Return the request-scoped session before a long-lived ``StreamingResponse``.

    FastAPI keeps ``Depends(get_db)`` / yield deps open until the response body
    finishes. For SSE that is the whole stream — often minutes (chat) or until
    the app closes (realtime). Callers must close explicitly after any preflight
    that needed the session, and before returning ``StreamingResponse``, so the
    pooled connection is not held for the stream lifetime.
    """
    await session.close()


# Idle keep-alive cadence. When the producer is mid-thought (no events queued),
# the generator emits a comment frame this often so the connection keeps flowing
# bytes; the client's stall watchdog uses those bytes to tell "still working"
# from "dead stream". Must stay well under the client idle timeout (see
# streamConversation.ts) so a slow-but-alive turn is never mistaken for a drop.
_HEARTBEAT_INTERVAL_S = 15.0

# Marks the end of clear-then-fold replay (+ hot re-hang) so clients can buffer
# and apply the catch-up segment in one paint, then live-tail. Comment frame —
# not an EventType (no journal / conformance). Desktop + mobile pump parsers
# recognize the same token; older clients ignore unknown ``:`` comments.
_ATTACH_CAUGHT_UP = ": attach-caught-up\n\n"


def _format_sse(event: SSEEvent, *, seq: int | None = None) -> str:
    """Serialize one SSE frame. Envelope JSON (type/timestamp/payload) is unchanged.

    Optional ``seq`` (or ``event.seq``) emits a standard SSE ``id:`` line (journal seq
    for DURABLE facts; ``Last-Event-ID`` resume). EPHEMERAL / delta events omit ``seq``
    so they attach after the nearest durable id.
    """
    id_seq = seq if seq is not None else event.seq
    data = json.dumps(
        {"type": event.type, "timestamp": event.timestamp, "payload": event.payload},
        ensure_ascii=False,
    )
    parts = [f"event: {event.type}"]
    if id_seq is not None:
        parts.append(f"id: {id_seq}")
    parts.append(f"data: {data}")
    return "\n".join(parts) + "\n\n"


async def _live_tail(
    sub: SinkSubscription,
    *,
    ambient: ConversationWatcher | None = None,
) -> AsyncIterator[str]:
    """Drain one subscription into SSE frames with idle ping comments.

    Same pattern as realtime ``_firehose``: a persistent ``get`` task is reused
    across heartbeat windows and is **never** cancelled on a mere timeout.

    Cancel safety: ``SinkSubscription.get`` may already hold a dequeued event and be
    waiting for its emit-side ``seq`` backfill. ``asyncio.wait_for(get, …)`` would
    cancel that await on heartbeat and drop the event; ``asyncio.wait`` leaves the get
    task running so idle still pings without that race. The get task is cancelled only
    on teardown (disconnect / generator close), when this consumer is going away anyway.

    ``ambient`` (对话级订阅 only) merges the conversation's own signal lane into this
    tail, so队列 / deferred 短暂态 reach a端 that happens to be mid-run. Its wait is a
    pure「有货了」flag — cancelling it (heartbeat teardown / close) dequeues nothing, so
    a signal landing at the run boundary is still there for the idle loop to pick up.
    """
    get_task: asyncio.Task[SSEEvent | None] | None = None
    signal_task: asyncio.Task[None] | None = None
    try:
        while True:
            if get_task is None:
                get_task = asyncio.ensure_future(sub.get())
            waiting: set[asyncio.Future] = {get_task}
            if ambient is not None:
                if signal_task is None:
                    signal_task = asyncio.ensure_future(ambient.wait_signals())
                waiting.add(signal_task)
            # FIRST_COMPLETED is load-bearing: ``ambient.wait_signals`` only resolves when
            # a signal shows up, so the default ALL_COMPLETED would hold every frame until
            # the heartbeat timeout — a对话级订阅 would tail 15s behind the turn it watches.
            done, _ = await asyncio.wait(
                waiting,
                timeout=_HEARTBEAT_INTERVAL_S,
                return_when=asyncio.FIRST_COMPLETED,
            )
            signalled = False
            if ambient is not None:
                for signal in ambient.drain_signals():
                    signalled = True
                    yield _format_sse(signal)
                if signal_task is not None and signal_task.done():
                    signal_task = None
            if get_task not in done:
                # Idle keep-alive — turn alive but no frame ready yet (or get is
                # still behind a persist barrier). Do not cancel get_task here.
                if not signalled:
                    yield ": ping\n\n"
                continue
            event = get_task.result()
            get_task = None
            if event is None:
                return
            yield _format_sse(event)
    finally:
        if get_task is not None:
            get_task.cancel()
        if signal_task is not None:
            signal_task.cancel()


async def _event_generator(
    sink: EventSink,
    producer: asyncio.Task | None,
    *,
    detach_on_disconnect: bool = False,
) -> AsyncIterator[str]:
    # Subscribe with the handoff backlog: this connection owns the frames emitted
    # between sink creation and the first read (preflight warnings /
    # ``turn_queue_started``), which nobody else has consumed.
    sub = sink.subscribe(label="turn_stream", backlog=True)
    try:
        async for frame in _live_tail(sub):
            yield frame
        sink.unsubscribe(sub, reason="sse_stream_end")
    except (asyncio.CancelledError, GeneratorExit):
        # The client disconnected before the stream finished. Dropping THIS consumer
        # never touches its peers (断开不连坐) — two policies differ only on the producer:
        #
        # - detach_on_disconnect (chat turns, 执行与请求解耦 C1 · slice 1a): the run
        #   is detached + tracked in the TurnRunRegistry, so a dropped connection
        #   must NOT kill it (案例 1: 断连即丢交付) — it finishes + persists in the
        #   background, and an explicit 停止 routes through POST .../stop instead.
        # - else (handoff archive/dispatch/apply SSEs): cancel the producer so it
        #   stops burning work for a response nobody will read.
        sink.unsubscribe(sub, reason="sse_disconnect")
        if not detach_on_disconnect and producer is not None and not producer.done():
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


async def _catch_up_replay(sink: EventSink, *, last_event_id: int | None) -> list[SSEEvent]:
    """The replay段 a freshly subscribed观察端 needs to reach the live edge.

    ``last_event_id is None`` → same-process fast path: the sink's own in-memory
    history (plus the synthetic ``message_end`` when the turn already finished).
    Otherwise the journal-backed full-turn replay + stream_state synthetic deltas.

    The header value stays observational: clients clear-then-fold the catch-up段, so a
    ``seq > cursor`` tail would drop the pre-cursor structure (tools / team graph /
    process narration) they just cleared. Per-端 cursors are already independent (each
    connection carries its own header and gets its own replay); making the replay
    *incremental* is a client-contract change, not a server switch.
    """
    if last_event_id is None:
        return sink.history_snapshot()
    from agentcore.runtime.events.attach_replay import build_cursor_replay

    turn_id = sink._message_id
    if not turn_id:
        return []
    agent_ids = sink._checkpointer.run_agent_ids() if sink._checkpointer is not None else {}
    return await build_cursor_replay(
        turn_id=turn_id,
        conversation_id=sink.conversation_id or "",
        after_seq=last_event_id,
        memory_channels=sink.stream_memory_snapshot(),
        memory_agent_ids=agent_ids,
    )


async def _attach_frames(
    sink: EventSink,
    sub: SinkSubscription,
    *,
    last_event_id: int | None = None,
    ambient: ConversationWatcher | None = None,
) -> AsyncIterator[str]:
    """Replay → hot re-hang → ``: attach-caught-up`` → live tail, for ONE run.

    ``sub`` must already be subscribed (the caller does it synchronously, before the
    replay snapshot, so nothing emitted in between is lost). Shared by the single-turn
    attach stream and the conversation-level stream, which walks run after run.

    ``ambient`` is the conversation watcher when this is a对话级订阅: its signals are
    merged into the live tail (a signal arriving during the replay段 flushes right after
    the boundary comment, never into the catch-up段).
    """
    for event in await _catch_up_replay(sink, last_event_id=last_event_id):
        yield _format_sse(event)
    # Hot re-hang: after journal/history replay (DURABLE-only for cursor path),
    # re-emit still-open answerable hot cards (approval / delegation / user
    # escalation) so a refresh cannot drop an in-process pending Future.
    conv_id = sink.conversation_id
    if conv_id:
        # CLIENT_TOOL ``*_required`` re-hang moved to the fulfill channel
        # (device connect / reconnect) — display attach only re-hangs hot
        # user-facing cards (approval / delegation / escalation).
        from agentcore.runtime.events.hot_interaction_reattach import (
            pending_hot_interaction_events,
        )

        for event in pending_hot_interaction_events(conv_id):
            yield _format_sse(event)
    # Boundary: everything above is catch-up; clients one-shot fold then live.
    yield _ATTACH_CAUGHT_UP
    async for frame in _live_tail(sub, ambient=ambient):
        yield frame


async def _attach_generator(
    sink: EventSink,
    *,
    last_event_id: int | None = None,
) -> AsyncIterator[str]:
    """Replay a running turn's transcript, then tail it live (实时重连续看, C1 · 1b).

    Used by the attach endpoint when a client re-connects to a still-running detached
    run. Subscribing is synchronous and additive — this观察端 is one of N peers, so
    attaching neither evicts nor starves whoever else is watching, and dropping it only
    unsubscribes this one connection (it never cancels the turn).

    With ``Last-Event-ID`` (P3): journal-backed full-turn durable replay + stream_state
    synthetic deltas, emit ``: attach-caught-up``, then live tail.
    """
    sub = sink.subscribe(label="attach")
    try:
        async for frame in _attach_frames(sink, sub, last_event_id=last_event_id):
            yield frame
        sink.unsubscribe(sub, reason="sse_attach_end")
    except (asyncio.CancelledError, GeneratorExit):
        sink.unsubscribe(sub, reason="sse_attach_disconnect")
        raise


def sse_attach_response(
    sink: EventSink,
    *,
    last_event_id: int | None = None,
) -> StreamingResponse:
    """Stream a re-attaching client the replay-then-tail of a live detached run (1b).

    The run keeps executing independently (执行与请求解耦); this is a pure observer that
    replays what the client missed and follows along, so dropping it again is harmless
    (unsubscribe, never cancel — an explicit 停止 still goes through ``POST .../stop``).
    """
    return StreamingResponse(
        _attach_generator(sink, last_event_id=last_event_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _conversation_generator(
    watcher: ConversationWatcher,
    *,
    initial_sink: EventSink | None = None,
    last_event_id: int | None = None,
) -> AsyncIterator[str]:
    """Follow a CONVERSATION across turns: replay+tail each run, heartbeat in between.

    The idle gap is the point (云对话多端同权 B2 · §2.3). A端 parked here does not get a
    ``204`` and then miss everything after it: when the next run registers — plain send,
    FIFO drain, cold-resume wake, stage_card — the hub hands over that sink and this
    stream replays + tails it exactly like a fresh attach, boundary comment included
    (clients already treat the catch-up段 as idempotent, so no protocol change).

    The same gap swallows the queue-class短暂态 (``turn_queued`` /
    ``turn_queue_cancelled`` / ``resume_deferred``): they belong to the conversation and
    can fire with no sink at all. They arrive on the watcher's signal lane instead and
    are merged here in BOTH phases — idle wait and mid-run tail — so a端 sees them
    whatever it happens to be doing (验收 5).

    ``last_event_id`` applies only to the run that was already live at connect; each
    later run starts from its own sink history, which IS its whole story.
    """
    sink = initial_sink
    sub: SinkSubscription | None = None
    cursor = last_event_id
    wait_task: asyncio.Task[EventSink] | None = None
    signal_task: asyncio.Task[None] | None = None
    # A run that registers between ``watch`` and the live-run lookup arrives BOTH as
    # ``initial_sink`` and through the hub — attach to it once.
    seen: deque[EventSink] = deque(maxlen=4)
    try:
        while True:
            if sink is None:
                if wait_task is None:
                    wait_task = asyncio.ensure_future(watcher.next_run())
                if signal_task is None:
                    signal_task = asyncio.ensure_future(watcher.wait_signals())
                # FIRST_COMPLETED, same reason as ``_live_tail``: an idle conversation
                # never resolves ``wait_signals``, so ALL_COMPLETED would delay picking up
                # the next run by up to a full heartbeat — the端 would see a turn only
                # after it had already finished (真跑实测晚 12.6s，帧还退化成块状重放).
                done, _ = await asyncio.wait(
                    {wait_task, signal_task},
                    timeout=_HEARTBEAT_INTERVAL_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                signalled = False
                for signal in watcher.drain_signals():
                    signalled = True
                    yield _format_sse(signal)
                if signal_task.done():
                    signal_task = None
                if wait_task not in done:
                    # Idle conversation — keep bytes flowing so the client's stall
                    # watchdog can tell "nothing happening" from "socket is dead".
                    if not signalled:
                        yield ": ping\n\n"
                    continue
                published = wait_task.result()
                wait_task = None
                cursor = None
                if any(published is s for s in seen):
                    continue
                sink = published
                continue
            seen.append(sink)
            sub = sink.subscribe(label="conversation_stream")
            # Same synchronous step as subscribe: from here a signal that also rides
            # this sink must NOT be duplicated onto the ambient lane (publish_signal).
            watcher.mark_tailing(sink)
            async for frame in _attach_frames(sink, sub, last_event_id=cursor, ambient=watcher):
                yield frame
            # The run closed its sink: unsubscribe and go back to waiting. The HTTP
            # stream stays open — the conversation, not the turn, is the subscription.
            watcher.mark_tailing(None)
            sink.unsubscribe(sub, reason="conversation_stream_turn_end")
            sub = None
            sink = None
            cursor = None
    finally:
        if wait_task is not None:
            wait_task.cancel()
        if signal_task is not None:
            signal_task.cancel()
        watcher.mark_tailing(None)
        if sub is not None and sink is not None:
            sink.unsubscribe(sub, reason="conversation_stream_disconnect")
        conversation_streams.unwatch(watcher)


def sse_conversation_response(
    conversation_id: str,
    *,
    last_event_id: int | None = None,
) -> StreamingResponse:
    """Stream a conversation-level subscription: current run (if any), then every next.

    Registers the watcher **before** reading the live-run slot so a turn starting in
    that window is delivered by the hub rather than lost between the two lookups; the
    generator skips it if it is the very sink it already attached to.
    """
    from agentcore.runtime.turn.runs import turn_runs

    watcher = conversation_streams.watch(conversation_id)
    run = turn_runs.get(conversation_id)
    initial_sink = run.sink if run is not None and not run.task.done() else None
    return StreamingResponse(
        _conversation_generator(
            watcher,
            initial_sink=initial_sink,
            last_event_id=last_event_id,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _queued_turn_generator(
    *,
    conversation_id: str,
    queue_id: str,
    position: int,
    queue_depth: int,
    started: asyncio.Future[EventSink],
    degraded_from: str | None = None,
) -> AsyncIterator[str]:
    """Emit ``turn_queued``, wait for drain, then consume the live turn sink (发送即有流).

    Disconnect closes the「断连 → detached」loop at EVERY stage (the turn itself is
    never cancelled here — D9 排队断连不 cancel 回合):

    - **waiting** (``started`` pending; drop at the ``turn_queued`` yield or at the
      await) → cancel ``started`` so drain starts the turn detached;
    - **handoff landed but never consumed** (drain ``set_result`` raced the disconnect
      — GeneratorExit lands before this generator resumes with the sink) → detach the
      HANDED sink, else it strands as a primary observer nobody reads;
    - **streaming** → ``_event_generator``'s own except detaches (same as primary
      send); our except re-detaches, which is an idempotent no-op.
    """
    from agentcore.runtime.events import turn_queued

    sink: EventSink | None = None
    try:
        yield _format_sse(
            turn_queued(
                queue_id=queue_id,
                position=position,
                queue_depth=queue_depth,
                conversation_id=conversation_id,
                degraded_from=degraded_from,
            )
        )
        sink = await started
        # Primary consumer of the drained turn (mirror send_message's detach policy).
        async for frame in _event_generator(sink, None, detach_on_disconnect=True):
            yield frame
    except (asyncio.CancelledError, GeneratorExit):
        if not started.done():
            started.cancel()
        else:
            handed = sink
            if handed is None and not started.cancelled() and started.exception() is None:
                handed = started.result()
            if handed is not None:
                # ``_event_generator`` (which owns subscribe/unsubscribe) may never have
                # been entered — record that the handed sink runs with nobody listening.
                handed.note_no_consumer(reason="sse_queued_disconnect")
        raise


def sse_queued_response(
    *,
    conversation_id: str,
    queue_id: str,
    position: int,
    queue_depth: int,
    started: asyncio.Future[EventSink],
    degraded_from: str | None = None,
) -> StreamingResponse:
    """SSE for an enqueued POST: ``turn_queued`` then same-connection turn stream."""
    return StreamingResponse(
        _queued_turn_generator(
            conversation_id=conversation_id,
            queue_id=queue_id,
            position=position,
            queue_depth=queue_depth,
            started=started,
            degraded_from=degraded_from,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _resume_deferred_generator(
    *,
    message_id: str,
    conversation_id: str,
    busy_reason: Literal["wrap_up", "live_turn"],
    started: asyncio.Future[EventSink],
) -> AsyncIterator[str]:
    """Emit ``resume_deferred``, wait for slot, then consume the resume sink.

    Disconnect while waiting cancels ``started`` so wake starts resume detached
    (settlement already durable — aligned with FIFO queued disconnect).
    """
    from agentcore.runtime.events import resume_deferred

    sink: EventSink | None = None
    try:
        yield _format_sse(
            resume_deferred(
                message_id=message_id,
                conversation_id=conversation_id,
                busy_reason=busy_reason,
            )
        )
        sink = await started
        async for frame in _event_generator(sink, None, detach_on_disconnect=True):
            yield frame
    except (asyncio.CancelledError, GeneratorExit):
        if not started.done():
            started.cancel()
        else:
            handed = sink
            if handed is None and not started.cancelled() and started.exception() is None:
                handed = started.result()
            if handed is not None:
                handed.note_no_consumer(reason="sse_resume_deferred_disconnect")
        raise


def sse_resume_deferred_response(
    *,
    message_id: str,
    conversation_id: str,
    busy_reason: Literal["wrap_up", "live_turn"],
    started: asyncio.Future[EventSink],
) -> StreamingResponse:
    """SSE for busy cold resume: ``resume_deferred`` then same-connection continuation."""
    return StreamingResponse(
        _resume_deferred_generator(
            message_id=message_id,
            conversation_id=conversation_id,
            busy_reason=busy_reason,
            started=started,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
