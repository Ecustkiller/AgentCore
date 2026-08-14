"""Account-level「哪些云对话还在跑」on GET /v1/fulfill.

Connect seed ``ai_turn_activity_snapshot`` (client replace) + incremental
``ai_turn_activity``. No realtime, no ai_attention, no FCM, no thin REST.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from agentcore.api.routes.fulfill import (
    _running_conversation_ids_for_seed,
    _seed_registered_session,
)
from agentcore.fulfill.hub import FulfillerHub
from agentcore.fulfill.user_signal import (
    FRAME_ATTENTION_SNAPSHOT,
    FRAME_QUEUE_ACCOUNT_SNAPSHOT,
    FRAME_TURN_ACTIVITY,
    FRAME_TURN_ACTIVITY_SNAPSHOT,
    turn_activity_frame,
    turn_activity_snapshot_frame,
)
from agentcore.runtime.events import EventSink
from agentcore.runtime.events.types import FinishReason
from agentcore.runtime.turn.queue import TurnQueue, new_queued_turn, turn_queue
from agentcore.runtime.turn.runs import (
    TurnRunRegistry,
    activity_done_reason,
    turn_runs,
)


async def _never() -> None:
    await asyncio.Event().wait()


async def _quick() -> None:
    return None


def _capture_activity(monkeypatch) -> list[tuple[str, dict]]:
    events: list[tuple[str, dict]] = []

    def running(*, user_id: str, conversation_id: str) -> int:
        events.append(
            ("running", {"user_id": user_id, "conversation_id": conversation_id})
        )
        return 1

    def done(*, user_id: str, conversation_id: str, reason: str) -> int:
        events.append(
            (
                "done",
                {
                    "user_id": user_id,
                    "conversation_id": conversation_id,
                    "reason": reason,
                },
            )
        )
        return 1

    monkeypatch.setattr(
        "agentcore.runtime.turn.runs.push_turn_activity_running", running
    )
    monkeypatch.setattr("agentcore.runtime.turn.runs.push_turn_activity_done", done)
    return events


def test_activity_frames_match_the_wire_contract():
    snap = turn_activity_snapshot_frame(["c1", "c2"])
    assert snap == {
        "type": FRAME_TURN_ACTIVITY_SNAPSHOT,
        "payload": {"running": ["c1", "c2"]},
    }
    running = turn_activity_frame("c1", "running")
    assert running == {
        "type": FRAME_TURN_ACTIVITY,
        "payload": {"conversation_id": "c1", "state": "running"},
    }
    assert "reason" not in running["payload"]
    done = turn_activity_frame("c1", "done", reason="paused")
    assert done["payload"] == {
        "conversation_id": "c1",
        "state": "done",
        "reason": "paused",
    }


async def test_connect_seed_delivers_activity_snapshot(monkeypatch):
    """Connection seed is a replace snapshot from the caller-supplied lease set."""
    monkeypatch.setattr("agentcore.api.routes.fulfill.turn_queue", TurnQueue())
    monkeypatch.setattr(
        "agentcore.runtime.events.client_tool_reattach.rehang_pending_client_tools",
        lambda user_id: 0,
    )
    hub = FulfillerHub()
    session = hub.register("u1", "web-1", caps=[], roots=[], platform="web")
    _seed_registered_session(
        session, hub, running_conversation_ids=["c-live", "c-other"]
    )
    queue_frame = await session.get()
    assert queue_frame == {
        "type": FRAME_QUEUE_ACCOUNT_SNAPSHOT,
        "payload": {"queues": []},
    }
    frame = await session.get()
    assert frame["type"] == FRAME_TURN_ACTIVITY_SNAPSHOT
    assert frame["payload"] == {"running": ["c-live", "c-other"]}


async def test_connect_seed_empty_running_still_replace(monkeypatch):
    """Empty snapshot is still delivered — client replace, not 'clear on open'."""
    monkeypatch.setattr("agentcore.api.routes.fulfill.turn_queue", TurnQueue())
    monkeypatch.setattr(
        "agentcore.runtime.events.client_tool_reattach.rehang_pending_client_tools",
        lambda user_id: 0,
    )
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    _seed_registered_session(session, hub, running_conversation_ids=[])
    queue_frame = await session.get()
    assert queue_frame == {
        "type": FRAME_QUEUE_ACCOUNT_SNAPSHOT,
        "payload": {"queues": []},
    }
    frame = await session.get()
    assert frame == {
        "type": FRAME_TURN_ACTIVITY_SNAPSHOT,
        "payload": {"running": []},
    }


async def test_seed_lease_query_failure_does_not_replace(monkeypatch):
    """查库失败返回 None：该路不发 snapshot replace，不能拿空表灭灯。"""

    async def boom(user_id, *, session=None, after=None):
        raise RuntimeError("db down")

    monkeypatch.setattr(
        "agentcore.api.routes.fulfill.list_fresh_conversation_ids_for_user",
        boom,
    )
    blocker = asyncio.create_task(_never())
    try:
        turn_runs.register(
            conversation_id="from-registry",
            task=blocker,
            sink=EventSink(),
            user_id="u-seed",
        )
        assert await _running_conversation_ids_for_seed(MagicMock(), "u-seed") is None
    finally:
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        await asyncio.sleep(0)


async def test_connect_seed_query_failure_does_not_send_empty_activity_replace(
    monkeypatch,
):
    monkeypatch.setattr("agentcore.api.routes.fulfill.turn_queue", TurnQueue())
    monkeypatch.setattr(
        "agentcore.runtime.events.client_tool_reattach.rehang_pending_client_tools",
        lambda user_id: 0,
    )
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    _seed_registered_session(
        session, hub, running_conversation_ids=None, attention_entries=[]
    )
    assert (await session.get())["type"] == FRAME_QUEUE_ACCOUNT_SNAPSHOT
    assert (await session.get())["type"] == FRAME_ATTENTION_SNAPSHOT
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(session.get(), timeout=0.05)


async def test_soft_deleted_conversation_not_in_activity_snapshot(monkeypatch):
    """已软删不进 snapshot：播种只采用 list_fresh_for_user 留下的活会话。"""

    async def fake_leases(user_id, *, session=None, after=None):
        return ["c-live"]

    monkeypatch.setattr(
        "agentcore.api.routes.fulfill.list_fresh_conversation_ids_for_user",
        fake_leases,
    )
    ids = await _running_conversation_ids_for_seed(MagicMock(), "u-seed")
    snap = turn_activity_snapshot_frame(ids or [])
    assert snap["payload"]["running"] == ["c-live"]


async def test_list_fresh_for_user_sql_excludes_deleted_conversations():
    from datetime import UTC, datetime

    from sqlalchemy.dialects import postgresql

    from agentcore.runtime.leases.repo import TurnLeaseRepository

    class _Scalars:
        def all(self):
            return []

    class _Result:
        def scalars(self):
            return _Scalars()

    class _Session:
        def __init__(self) -> None:
            self.statement = None

        async def execute(self, statement):
            self.statement = statement
            return _Result()

    session = _Session()
    await TurnLeaseRepository(session).list_fresh_for_user(
        "u1", after=datetime.now(UTC)
    )
    sql = str(session.statement.compile(dialect=postgresql.dialect()))
    assert "JOIN conversations" in sql
    assert "LEFT OUTER JOIN" not in sql
    assert "conversations.deleted_at IS NULL" in sql


async def test_seed_ids_read_leases_not_just_registry(monkeypatch):
    """播种读 turn_leases；registry 只补 register-before-lease 窗口。"""

    async def fake_leases(user_id, *, session=None, after=None):
        assert user_id == "u-seed"
        return ["from-lease"]

    monkeypatch.setattr(
        "agentcore.api.routes.fulfill.list_fresh_conversation_ids_for_user",
        fake_leases,
    )
    blocker = asyncio.create_task(_never())
    try:
        turn_runs.register(
            conversation_id="from-registry",
            task=blocker,
            sink=EventSink(),
            user_id="u-seed",
        )
        ids = await _running_conversation_ids_for_seed(MagicMock(), "u-seed")
        assert ids == ["from-lease", "from-registry"]
    finally:
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        await asyncio.sleep(0)


async def test_register_emits_running_without_reason(monkeypatch):
    events = _capture_activity(monkeypatch)
    reg = TurnRunRegistry()
    task = asyncio.create_task(_never())
    try:
        reg.register(
            conversation_id="c-run",
            task=task,
            sink=EventSink(),
            user_id="u1",
        )
        assert events == [
            ("running", {"user_id": "u1", "conversation_id": "c-run"})
        ]
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await asyncio.sleep(0)


async def test_slot_empty_emits_done_completed(monkeypatch):
    events = _capture_activity(monkeypatch)
    reg = TurnRunRegistry()
    task = asyncio.create_task(_quick())
    reg.register(
        conversation_id="c-done",
        task=task,
        sink=EventSink(),
        user_id="u1",
    )
    await task
    await asyncio.sleep(0)
    assert ("done", {"user_id": "u1", "conversation_id": "c-done", "reason": "completed"}) in events


async def test_pause_emits_done_reason_paused(monkeypatch):
    events = _capture_activity(monkeypatch)
    reg = TurnRunRegistry()
    sink = EventSink()
    sink._stream_finish_reason = FinishReason.PAUSED.value
    task = asyncio.create_task(_quick())
    reg.register(
        conversation_id="c-pause",
        task=task,
        sink=sink,
        user_id="u1",
    )
    await task
    await asyncio.sleep(0)
    assert (
        "done",
        {"user_id": "u1", "conversation_id": "c-pause", "reason": "paused"},
    ) in events


async def test_user_stop_emits_done_reason_stopped(monkeypatch):
    events = _capture_activity(monkeypatch)
    reg = TurnRunRegistry()
    task = asyncio.create_task(_never())
    reg.register(
        conversation_id="c-stop",
        task=task,
        sink=EventSink(),
        user_id="u1",
    )
    assert reg.stop("c-stop") is True
    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.sleep(0)
    assert (
        "done",
        {"user_id": "u1", "conversation_id": "c-stop", "reason": "stopped"},
    ) in events


async def test_drain_handoff_does_not_emit_done(monkeypatch):
    """FIFO 接棒：宿主结束不闪 done，下一回合 register 再发 running。"""
    events = _capture_activity(monkeypatch)
    started: list[str] = []

    async def fake_start(conversation_id: str, item) -> None:
        started.append(item.content)

    monkeypatch.setattr(
        "agentcore.runtime.turn.queue._start_queued_turn", fake_start
    )
    cid = "c-act-drain"
    turn_queue.clear(cid)
    blocker = asyncio.create_task(_never())
    try:
        turn_runs.register(
            conversation_id=cid,
            task=blocker,
            sink=EventSink(),
            user_id="u1",
        )
        turn_queue.enqueue(cid, new_queued_turn(content="queued-next", user_id="u1"))
        blocker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await blocker
        for _ in range(40):
            if started:
                break
            await asyncio.sleep(0.025)
        assert started == ["queued-next"]
        assert all(kind != "done" or ev["conversation_id"] != cid for kind, ev in events)
        assert ("running", {"user_id": "u1", "conversation_id": cid}) in events
    finally:
        turn_queue.clear(cid)
        if not blocker.done():
            blocker.cancel()
            with pytest.raises(asyncio.CancelledError):
                await blocker
        await asyncio.sleep(0)


async def test_overlap_does_not_emit_done_for_superseded_run(monkeypatch):
    events = _capture_activity(monkeypatch)
    reg = TurnRunRegistry()
    first = asyncio.create_task(_never())
    second = asyncio.create_task(_never())
    try:
        reg.register(
            conversation_id="c-ov", task=first, sink=EventSink(), user_id="u1"
        )
        reg.register(
            conversation_id="c-ov", task=second, sink=EventSink(), user_id="u1"
        )
        with pytest.raises(asyncio.CancelledError):
            await first
        await asyncio.sleep(0)
        assert [kind for kind, _ in events] == ["running", "running"]
        assert all(kind != "done" for kind, _ in events)
    finally:
        for t in (first, second):
            if not t.done():
                t.cancel()
        await asyncio.sleep(0)


def test_activity_done_reason_paused_and_error():
    sink = EventSink()
    sink._stream_finish_reason = FinishReason.PAUSED.value
    run = type("R", (), {"user_stopped": False, "sink": sink, "task": MagicMock()})()
    run.task.done.return_value = True
    run.task.cancelled.return_value = False
    run.task.exception.return_value = None
    assert activity_done_reason(run) == "paused"

    sink._stream_finish_reason = FinishReason.ERROR.value
    assert activity_done_reason(run) == "error"
