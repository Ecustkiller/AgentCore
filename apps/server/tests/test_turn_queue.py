"""Conversation-level turn queue: explicit serialisation of parallel POST messages."""

from __future__ import annotations

import asyncio

import pytest

from agentcore.runtime.events import EventSink
from agentcore.runtime.turn_queue import QueuedTurn, TurnQueue, new_queued_turn, turn_queue
from agentcore.runtime.turn_runs import TurnRunRegistry, turn_runs


async def _never() -> None:
    await asyncio.Future()


def test_enqueue_reports_visible_position_and_depth():
    q = TurnQueue()
    a = new_queued_turn(content="first", user_id="u")
    b = new_queued_turn(content="second", user_id="u")
    s1 = q.enqueue("c1", a)
    s2 = q.enqueue("c1", b)
    assert s1.position == 1 and s1.queue_depth == 1
    assert s2.position == 2 and s2.queue_depth == 2
    assert q.depth("c1") == 2
    assert q.pop_next("c1") is a
    assert q.pop_next("c1") is b
    assert q.pop_next("c1") is None


async def test_turn_done_callback_drains_module_queue(monkeypatch):
    """契约：in-flight turn 结束后按 FIFO 自动起下一回合。"""
    started: list[str] = []

    async def fake_start(conversation_id: str, item: QueuedTurn) -> None:
        started.append(item.content)

    monkeypatch.setattr(
        "agentcore.runtime.turn_queue._start_queued_turn", fake_start
    )
    turn_queue.clear("c-drain")

    blocker = asyncio.create_task(_never())
    turn_runs.register(conversation_id="c-drain", task=blocker, sink=EventSink())
    turn_queue.enqueue(
        "c-drain", new_queued_turn(content="queued-msg", user_id="u")
    )

    blocker.cancel()
    with pytest.raises(asyncio.CancelledError):
        await blocker
    # Allow done-callback → schedule_drain → _drain → fake_start.
    for _ in range(40):
        if started:
            break
        await asyncio.sleep(0.025)
    assert started == ["queued-msg"]
    turn_queue.clear("c-drain")


async def test_register_overlap_warning_is_the_old_grey_zone_behaviour():
    """根因钉死：直接 register 重叠会覆盖 slot（send_message 路径已改为入队）。"""
    reg = TurnRunRegistry()
    first = asyncio.create_task(_never())
    second = asyncio.create_task(_never())
    try:
        reg.register(conversation_id="c1", task=first, sink=EventSink())
        reg.register(conversation_id="c1", task=second, sink=EventSink())
        assert reg.get("c1").task is second
    finally:
        for t in (first, second):
            if not t.done():
                t.cancel()


def test_module_singleton_clear():
    turn_queue.clear("t-clear")
    turn_queue.enqueue("t-clear", new_queued_turn(content="x", user_id="u"))
    assert turn_queue.depth("t-clear") == 1
    assert turn_queue.clear("t-clear") == 1
    assert turn_queue.depth("t-clear") == 0
