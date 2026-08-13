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
    claimed: list[tuple[str, str, str]] = []

    async def fake_claim(
        message_id: str,
        conversation_id: str | None = None,
        *,
        decision: str = "",
        settled_by: str = "",
    ):
        claimed.append((message_id, decision, settled_by))
        return object()  # truthy suspension stand-in

    async def fake_resume_chat(**_kwargs):
        await asyncio.sleep(0)

    monkeypatch.setattr(
        "agentcore.runtime.suspension.persistence.claim_paused_turn", fake_claim
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
            origin_device_id="dev-deferred",
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
    # 延后唤醒同样是这张卡的结算方：claim 里带上它要施加的决策与结算设备，
    # 否则落败方读到的结论会缺掉正是这一次续跑的那份。
    assert claimed == [("paused-1", "continue", "dev-deferred")]
    for _ in range(40):
        if turn_runs.get(cid) is None:
            break
        await asyncio.sleep(0.025)
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001


async def test_wake_failure_unwinds_waiter_and_schedules_drain(monkeypatch):
    """The wake coroutine is detached: a claim that raises must settle it itself.

    Otherwise the user's「继续」SSE waits on ``started`` forever (no timeout on the
    route side) and the conversation's queued messages never drain.
    """
    drained: list[str] = []

    async def boom_claim(_message_id: str, **_kwargs):
        raise RuntimeError("claim exploded")

    monkeypatch.setattr(
        "agentcore.runtime.suspension.persistence.claim_paused_turn", boom_claim
    )
    monkeypatch.setattr(
        turn_queue, "schedule_drain", lambda cid: drained.append(cid)
    )

    cid = "c-deferred-wake-failure"
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001

    host = asyncio.create_task(_never())
    turn_runs.register(
        conversation_id=cid, task=host, sink=EventSink(message_id="host")
    )

    started: asyncio.Future = asyncio.get_running_loop().create_future()
    turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-boom",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=started,
        )
    )

    host.cancel()
    with pytest.raises(asyncio.CancelledError):
        await host

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(started, timeout=2.0)
    assert drained == [cid]
    turn_queue.clear(cid)
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001


async def test_same_message_id_resume_joins_instead_of_cutting_the_first_stream():
    """重复提交同一张冷卡 = 幂等 join：共用 waiter，第一条流不被掐断。"""
    cid = "c-deferred-join"
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001
    host = asyncio.create_task(_never())
    turn_runs.register(
        conversation_id=cid, task=host, sink=EventSink(message_id="host")
    )
    loop = asyncio.get_running_loop()

    first: asyncio.Future = loop.create_future()
    second: asyncio.Future = loop.create_future()
    parked = turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-same",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=first,
        )
    )
    joined = turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-same",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=second,
        )
    )

    assert joined is parked
    assert turn_runs._resume_deferred[cid] is parked  # noqa: SLF001
    assert not first.cancelled()
    assert parked.waiting() == [first, second]
    # One resume run, both SSEs served off the same sink.
    sink = EventSink(message_id="paused-same")
    assert parked.settle(sink) is True
    assert first.result() is sink
    assert second.result() is sink

    # Another cold card of the same conversation still wins (last click wins).
    third: asyncio.Future = loop.create_future()
    other = turn_runs.register_resume_deferred(
        ResumeDeferredWaiter(
            conversation_id=cid,
            message_id="paused-other",
            busy_reason="live_turn",
            checkpoint_response=_checkpoint(),
            started=third,
        )
    )
    assert other is not parked
    assert turn_runs._resume_deferred[cid] is other  # noqa: SLF001

    host.cancel()
    with pytest.raises(asyncio.CancelledError):
        await host
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001
    if not third.done():
        third.cancel()


async def test_repark_does_not_evict_a_waiter_registered_while_armed(monkeypatch):
    """Slot re-taken between arm and run: re-park must not clobber the newer card."""
    claimed: list[str] = []

    async def fake_claim(message_id: str, **_kwargs):
        claimed.append(message_id)
        return object()

    monkeypatch.setattr(
        "agentcore.runtime.suspension.persistence.claim_paused_turn", fake_claim
    )

    cid = "c-deferred-repark"
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001
    loop = asyncio.get_running_loop()

    armed = ResumeDeferredWaiter(
        conversation_id=cid,
        message_id="paused-armed",
        busy_reason="live_turn",
        checkpoint_response=_checkpoint(),
        started=loop.create_future(),
    )
    newer_started: asyncio.Future = loop.create_future()
    newer = ResumeDeferredWaiter(
        conversation_id=cid,
        message_id="paused-newer",
        busy_reason="live_turn",
        checkpoint_response=_checkpoint(),
        started=newer_started,
    )
    turn_runs._resume_deferred[cid] = newer  # noqa: SLF001

    # The armed wake finds the slot taken again and re-parks.
    host = asyncio.create_task(_never())
    turn_runs.register(
        conversation_id=cid, task=host, sink=EventSink(message_id="host")
    )
    await turn_runs._start_resume_deferred(armed)  # noqa: SLF001

    assert claimed == []
    assert turn_runs._resume_deferred[cid] is newer  # noqa: SLF001
    assert not newer_started.done()
    assert armed.started is not None and armed.started.cancelled()

    host.cancel()
    with pytest.raises(asyncio.CancelledError):
        await host
    turn_runs._resume_deferred.pop(cid, None)  # noqa: SLF001
    newer_started.cancel()


async def test_fifo_yields_to_deferred_then_drains(monkeypatch):
    """Slot empty: deferred starts first; FIFO only after deferred run finishes."""
    started_queue: list[str] = []
    resume_started = asyncio.Event()
    resume_release = asyncio.Event()

    async def fake_start_queued(_conversation_id: str, item: QueuedTurn) -> None:
        started_queue.append(item.content)

    async def fake_claim(message_id: str, **_kwargs):
        return object()

    async def fake_resume_chat(**_kwargs):
        resume_started.set()
        await resume_release.wait()

    monkeypatch.setattr(
        "agentcore.runtime.turn.queue._start_queued_turn", fake_start_queued
    )
    monkeypatch.setattr(
        "agentcore.runtime.suspension.persistence.claim_paused_turn", fake_claim
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
