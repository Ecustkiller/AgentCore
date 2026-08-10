"""Cold resume × live deferred: busy → resume_deferred → slot-empty continue; FIFO yields."""

from __future__ import annotations

import asyncio

import pytest

from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType, resume_deferred
from agentcore.runtime.turn.queue import QueuedTurn, new_queued_turn, turn_queue
from agentcore.runtime.turn.runs import ResumeDeferredWaiter, TurnRunRegistry, turn_runs


async def _never() -> None:
    await asyncio.Future()


def _checkpoint() -> CheckpointResponse:
    return CheckpointResponse(decision=CheckpointDecision.CONTINUE)


def test_resume_deferred_factory_payload():
    ev = resume_deferred(
        message_id="m1",
        conversation_id="c1",
        busy_reason="wrap_up",
    )
    assert ev.type is EventType.RESUME_DEFERRED
    assert ev.payload == {
        "message_id": "m1",
        "conversation_id": "c1",
        "busy_reason": "wrap_up",
    }


async def test_busy_reason_wrap_up_vs_live_turn():
    reg = TurnRunRegistry()
    wrap_sink = EventSink(message_id="paused-msg")
    wrap_task = asyncio.create_task(_never())
    reg.register(conversation_id="c1", task=wrap_task, sink=wrap_sink)
    assert reg.busy_reason_for_resume("c1", "paused-msg") == "wrap_up"
    assert reg.busy_reason_for_resume("c1", "other-msg") == "live_turn"
    wrap_task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await wrap_task
    await asyncio.sleep(0)
    assert reg.busy_reason_for_resume("c1", "paused-msg") is None


async def test_busy_deferred_wakes_on_slot_empty(monkeypatch):
    """busy → register deferred → host ends → claim+resume starts; waiter gets sink."""
    claimed: list[str] = []

    async def fake_claim(message_id: str, conversation_id: str | None = None):
        claimed.append(message_id)
        return object()  # truthy suspension stand-in

    async def fake_resume_chat(**_kwargs):
        await asyncio.sleep(0)

    monkeypatch.setattr(
        "agentcore.runtime.suspension_persistence.claim_paused_turn", fake_claim
    )
    monkeypatch.setattr("agentcore.conversation.service.resume_chat", fake_resume_chat)

    cid = "c-deferred-wake"
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001

    host = asyncio.create_task(_never())
    host_sink = EventSink(message_id="live-other")
    turn_runs.register(conversation_id=cid, task=host, sink=host_sink)

    started: asyncio.Future = asyncio.get_running_loop().create_future()
    assert turn_runs.busy_reason_for_resume(cid, "paused-1") == "live_turn"
    turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-1",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=started,
        )
    )
    assert turn_runs.has_resume_deferred(cid)

    host.cancel()
    with pytest.raises(asyncio.CancelledError):
        await host

    sink = await asyncio.wait_for(started, timeout=2.0)
    assert isinstance(sink, EventSink)
    for _ in range(40):
        if claimed:
            break
        await asyncio.sleep(0.025)
    assert claimed == ["paused-1"]
    for _ in range(40):
        if turn_runs.get(cid) is None:
            break
        await asyncio.sleep(0.025)
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001


async def test_fifo_yields_to_deferred_then_drains(monkeypatch):
    """Slot empty: deferred starts first; FIFO only after deferred run finishes."""
    started_queue: list[str] = []
    resume_started = asyncio.Event()
    resume_release = asyncio.Event()

    async def fake_start_queued(_conversation_id: str, item: QueuedTurn) -> None:
        started_queue.append(item.content)

    async def fake_claim(message_id: str, conversation_id: str | None = None):
        return object()

    async def fake_resume_chat(**_kwargs):
        resume_started.set()
        await resume_release.wait()

    monkeypatch.setattr(
        "agentcore.runtime.turn.queue._start_queued_turn", fake_start_queued
    )
    monkeypatch.setattr(
        "agentcore.runtime.suspension_persistence.claim_paused_turn", fake_claim
    )
    monkeypatch.setattr("agentcore.conversation.service.resume_chat", fake_resume_chat)

    cid = "c-deferred-fifo"
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001

    host = asyncio.create_task(_never())
    turn_runs.register(
        conversation_id=cid, task=host, sink=EventSink(message_id="host")
    )
    turn_queue.enqueue(cid, new_queued_turn(content="queued-msg", user_id="u"))

    started: asyncio.Future = asyncio.get_running_loop().create_future()
    turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-fifo",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=started,
        )
    )

    host.cancel()
    with pytest.raises(asyncio.CancelledError):
        await host

    await asyncio.wait_for(started, timeout=2.0)
    await asyncio.wait_for(resume_started.wait(), timeout=2.0)
    # FIFO must still be blocked while deferred resume holds the slot.
    await asyncio.sleep(0.05)
    assert started_queue == []
    assert turn_queue.depth(cid) == 1

    resume_release.set()
    for _ in range(40):
        if started_queue:
            break
        await asyncio.sleep(0.025)
    assert started_queue == ["queued-msg"]
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001
