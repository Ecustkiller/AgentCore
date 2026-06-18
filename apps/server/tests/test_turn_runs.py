"""执行与请求解耦 (C1 · slice 1a): TurnRunRegistry + EventSink.detach + SSE policy.

These lock the decoupling that keeps a long turn alive past a dropped connection
(实测案例复盘 案例 1: a 7-min turn lost its SSE and threw away the delivery):

- the registry tracks the detached run per conversation and stops it on demand,
- ``EventSink.detach`` caps the unread queue while still journaling for persistence,
- ``_event_generator`` detaches (run continues) vs cancels (handoff) on disconnect.

No DB, no HTTP — plain async tests (asyncio_mode=auto).
"""

import asyncio

import pytest

from agentcore.api import sse
from agentcore.runtime.events import (
    EventSink,
    EventType,
    FinishReason,
    content_delta,
    message_end,
    reasoning_delta,
    run_output_delta,
    run_plan,
    run_started,
    tool_progress,
    tool_use_end,
    tool_use_start,
)
from agentcore.runtime.turn_runs import TurnRunRegistry


def _plan():
    return run_plan(
        execution_id="exec-1",
        plan_type="multi_agent",
        task_summary="1 worker",
        agents=[{"id": "a1", "role": "研究员"}],
        runs=[{"id": "s1", "agent_id": "a1", "task": "调研", "depends_on": []}],
    )


async def _never() -> None:
    """A task body that never finishes on its own (stands in for a live turn)."""
    await asyncio.Event().wait()


# --- TurnRunRegistry -------------------------------------------------------


async def test_register_get_and_stop_cancels_then_discards():
    reg = TurnRunRegistry()
    task = asyncio.create_task(_never())
    run_id = reg.register(conversation_id="c1", task=task, sink=EventSink())

    run = reg.get("c1")
    assert run is not None and run.run_id == run_id

    # Stop signals the live task and reports it found one.
    assert reg.stop("c1") is True
    with pytest.raises(asyncio.CancelledError):
        await task

    # The done-callback clears the slot once the task settles; a second stop is a
    # no-op (idempotent) so a late 停止 click does not error.
    await asyncio.sleep(0)
    assert reg.get("c1") is None
    assert reg.stop("c1") is False


async def test_stop_unknown_conversation_is_false():
    reg = TurnRunRegistry()
    assert reg.stop("missing") is False


async def test_finished_run_is_discarded():
    reg = TurnRunRegistry()

    async def _quick() -> None:
        return None

    task = asyncio.create_task(_quick())
    reg.register(conversation_id="c1", task=task, sink=EventSink())
    await task
    await asyncio.sleep(0)  # let the done-callback run

    assert reg.get("c1") is None
    assert reg.stop("c1") is False


async def test_overlapping_run_replaces_slot_without_evicting_newer():
    reg = TurnRunRegistry()
    first = asyncio.create_task(_never())
    second = asyncio.create_task(_never())
    try:
        reg.register(conversation_id="c1", task=first, sink=EventSink())
        reg.register(conversation_id="c1", task=second, sink=EventSink())
        # The newer run owns the slot...
        assert reg.get("c1").task is second
        # ...and the older task finishing must NOT evict the newer registration.
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        await asyncio.sleep(0)
        assert reg.get("c1") is not None
        assert reg.get("c1").task is second
    finally:
        for t in (first, second):
            if not t.done():
                t.cancel()


# --- EventSink.detach ------------------------------------------------------


def test_detach_stops_queue_but_keeps_journal():
    sink = EventSink()
    sink.emit(_plan())  # journaled AND queued for SSE
    assert sink._queue.qsize() == 1

    sink.detach()
    sink.emit(run_started("s1", "a1"))  # after detach: journaled, NOT queued

    # The queue did not grow (the consumer is gone)...
    assert sink._queue.qsize() == 1
    # ...but the durable journal still captured the post-detach event, so the turn
    # persists + replays in full even though nobody was reading.
    journal = sink.execution_journal()
    assert [e["type"] for e in journal] == [
        EventType.RUN_PLAN.value,
        EventType.RUN_STARTED.value,
    ]


# --- _event_generator disconnect policy -----------------------------------


async def test_disconnect_detaches_run_when_detach_on_disconnect(monkeypatch):
    # detach_on_disconnect (chat turns): a client disconnect must NOT cancel the
    # detached run — it only detaches the sink so the run finishes + persists.
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    sink = EventSink()
    producer = asyncio.create_task(_never())
    try:
        gen = sse._event_generator(sink, producer, detach_on_disconnect=True)
        # Idle once so the generator is suspended INSIDE its try (at the heartbeat
        # yield); only then does aclose() raise GeneratorExit into the except.
        first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert first.startswith(":")

        await gen.aclose()  # simulate client disconnect

        assert sink._detached is True
        assert not producer.done()  # the run keeps going
    finally:
        producer.cancel()


async def test_disconnect_cancels_producer_by_default(monkeypatch):
    # Default policy (handoff SSEs): a disconnect cancels the producer so it stops
    # working for a response nobody will read.
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    sink = EventSink()
    producer = asyncio.create_task(_never())

    gen = sse._event_generator(sink, producer)
    first = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert first.startswith(":")

    await gen.aclose()
    assert sink._detached is False
    with pytest.raises(asyncio.CancelledError):
        await producer


# --- EventSink reconnect history (slice 1b) --------------------------------


def test_history_coalesces_deltas_and_skips_liveliness():
    sink = EventSink()
    sink.emit(content_delta("a"))
    sink.emit(content_delta("b"))  # coalesces into the trailing content block
    sink.emit(tool_progress("delegate", 10))  # pure liveliness — skipped
    sink.emit(reasoning_delta("think"))
    sink.emit(tool_use_start("t1", "read", {}))
    sink.emit(tool_use_end("t1", "read", success=True, output="ok"))
    sink.emit(message_end(FinishReason.END_TURN))  # terminal — skipped

    hist = sink._history
    assert [e.type for e in hist] == [
        EventType.CONTENT_DELTA,
        EventType.REASONING_DELTA,
        EventType.TOOL_USE_START,
        EventType.TOOL_USE_END,
    ]
    assert hist[0].payload["delta"] == "ab"


def test_history_coalesces_run_deltas_per_run():
    sink = EventSink()
    sink.emit(run_output_delta("r1", "a1", "x"))
    sink.emit(run_output_delta("r1", "a1", "y"))  # same run → merge
    sink.emit(run_output_delta("r2", "a1", "z"))  # different run → new block

    hist = sink._history
    assert [(e.payload["run_id"], e.payload["delta"]) for e in hist] == [
        ("r1", "xy"),
        ("r2", "z"),
    ]


def test_history_caps_tool_result():
    sink = EventSink()
    big = "x" * 20_000
    sink.emit(tool_use_end("t1", "read_url", success=True, output=big))
    stored = sink._history[-1].payload["result"]
    assert stored.endswith("…")
    assert len(stored) < len(big)


async def test_take_over_replays_history_then_tails():
    sink = EventSink()
    sink.emit(content_delta("Hel"))
    sink.emit(content_delta("lo"))  # both queued AND folded into history
    sink.detach()  # consumer dropped — run continues
    sink.emit(content_delta("!"))  # history only (queue capped)

    snapshot = sink.take_over()
    # One coalesced content block carrying everything so far — the discarded queue
    # backlog is NOT replayed on top of it (no doubling).
    assert [e.type for e in snapshot] == [EventType.CONTENT_DELTA]
    assert snapshot[0].payload["delta"] == "Hello!"
    assert sink._queue.qsize() == 0

    # The queue is live again, so a post-attach event tails to the new consumer.
    sink.emit(content_delta(" more"))
    tail = await asyncio.wait_for(sink.get(), timeout=1.0)
    assert tail.payload["delta"] == " more"


async def test_take_over_on_finished_run_replays_then_ends():
    sink = EventSink()
    sink.emit(content_delta("done"))
    sink.close()  # run finished before the client re-attached

    snapshot = sink.take_over()
    assert [e.payload["delta"] for e in snapshot] == ["done"]
    # A closed sink hands the consumer the end sentinel so it replays then stops,
    # rather than re-opening a queue nothing will ever feed.
    assert await asyncio.wait_for(sink.get(), timeout=1.0) is None


async def test_attach_generator_replays_then_tails_then_closes(monkeypatch):
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    sink = EventSink()
    sink.emit(content_delta("Hi"))
    sink.detach()  # the original consumer dropped

    gen = sse._attach_generator(sink)
    replayed = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert "content_delta" in replayed and "Hi" in replayed

    sink.emit(content_delta(" there"))  # live tail after re-attach
    tailed = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    assert " there" in tailed

    sink.close()
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(gen.__anext__(), timeout=1.0)
