"""云对话多端同权 B2：N 端并听 — 同帧、不连坐、有界队列、emit 侧 seq、对话级续播。

三条今日故障的回归线（定案 §2 / §6.1）：

1. 单条 ``asyncio.Queue`` → 两端**瓜分帧**；现在每订阅者一条有界队列，同帧同发。
2. 任一端断开 → sink 级 ``_detached`` **连坐**掐所有端；现在只摘自己那条。
3. 无活跃 run 直接 204 → 停在空闲对话上的端此后**零信号**；现在对话级 watcher 收新回合。

外加最隐蔽的一条：``seq`` 过去靠「事件与 persist barrier 同序出队」的单消费者不变量
传递，多队列后必串号——回填已移到 emit 侧，这里锁死乱序落库也不串。

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
)
from agentcore.runtime.events.conversation_hub import ConversationStreamHub
from agentcore.runtime.events.sink import _SUBSCRIBER_QUEUE_MAXSIZE


async def _never() -> None:
    await asyncio.Event().wait()


async def _drain_deltas(sub, count: int) -> list[str]:
    out: list[str] = []
    for _ in range(count):
        event = await asyncio.wait_for(sub.get(), timeout=1.0)
        assert event is not None
        out.append(event.payload["delta"])
    return out


# --- 多订阅者：同帧、不瓜分 ---------------------------------------------------


async def test_two_subscribers_get_the_same_frames():
    """两端同开：每端拿到全量帧，而不是一人一半。"""
    sink = EventSink()
    a = sink.subscribe(label="a")
    b = sink.subscribe(label="b")
    assert sink.subscriber_count == 2

    for chunk in ("你", "好", "呀"):
        sink.emit(content_delta(chunk))

    assert await _drain_deltas(a, 3) == ["你", "好", "呀"]
    assert await _drain_deltas(b, 3) == ["你", "好", "呀"]


async def test_late_subscriber_tails_without_replaying_history():
    """后到端只跟新帧；历史由 replay（``history_snapshot`` / journal）负责，避免重折。"""
    sink = EventSink()
    early = sink.subscribe(label="early")
    sink.emit(content_delta("before"))
    assert await _drain_deltas(early, 1) == ["before"]

    late = sink.subscribe(label="late")
    sink.emit(content_delta("after"))

    assert await _drain_deltas(late, 1) == ["after"]
    assert await _drain_deltas(early, 1) == ["after"]
    assert [e.payload["delta"] for e in sink.history_snapshot()] == ["beforeafter"]


async def test_one_subscriber_dropping_does_not_touch_peers():
    """断开不连坐：摘掉一端后另一端照常收帧，sink 未关。"""
    sink = EventSink()
    a = sink.subscribe(label="a")
    b = sink.subscribe(label="b")

    sink.unsubscribe(a, reason="sse_disconnect")
    assert sink.subscriber_count == 1
    assert not sink.is_detached
    assert not sink.is_closed

    sink.emit(content_delta("still here"))
    assert await _drain_deltas(b, 1) == ["still here"]
    # 被摘的那端拿到收尾哨兵，仅此而已。
    assert await asyncio.wait_for(a.get(), timeout=1.0) is None


async def test_unsubscribe_is_idempotent_and_keeps_others():
    sink = EventSink()
    a = sink.subscribe(label="a")
    b = sink.subscribe(label="b")

    sink.unsubscribe(a)
    sink.unsubscribe(a)  # 重复摘（断连回调 + 生成器收尾）不得误伤 b
    assert sink.subscriber_count == 1

    sink.emit(content_delta("ok"))
    assert await _drain_deltas(b, 1) == ["ok"]


async def test_close_ends_every_subscriber():
    sink = EventSink()
    subs = [sink.subscribe(label=f"s{i}") for i in range(3)]
    sink.close()
    for sub in subs:
        assert await asyncio.wait_for(sub.get(), timeout=1.0) is None


# --- 有界队列：满则丢最旧，且只惩罚自己 --------------------------------------


async def test_slow_subscriber_sheds_oldest_and_does_not_stall_peers():
    """慢端积压到上限就丢最旧帧（ChatHub 范式），快端不受影响、emit 不阻塞。"""
    sink = EventSink()
    slow = sink.subscribe(label="slow")
    fast = sink.subscribe(label="fast")

    overflow = _SUBSCRIBER_QUEUE_MAXSIZE + 5
    for i in range(overflow):
        sink.emit(content_delta(str(i)))
        # 快端边发边收，永远不积压。
        assert (await asyncio.wait_for(fast.get(), timeout=1.0)).payload["delta"] == str(i)

    assert slow.dropped == 5
    assert slow._queue.qsize() == _SUBSCRIBER_QUEUE_MAXSIZE  # noqa: SLF001
    # 丢的是最旧的（0..4），队首是第 5 帧——最新的永远留着。
    assert (await asyncio.wait_for(slow.get(), timeout=1.0)).payload["delta"] == "5"


# --- emit 侧 seq 回填：多队列下不串号 -----------------------------------------


async def test_seq_backfill_is_per_event_not_per_dequeue_order():
    """乱序落库也不串号：seq 写在事件上（emit 侧），不再靠 barrier 出队配对。

    旧模型下 barrier 是一条并行队列，消费者「取第 n 个事件配第 n 个 barrier」；
    只要落库次序与出队次序不一致（或有第二个消费者），seq 就会挂到别的事件上。
    """
    sink = EventSink()
    sub = sink.subscribe()
    loop = asyncio.get_running_loop()
    first: asyncio.Future[int | None] = loop.create_future()
    second: asyncio.Future[int | None] = loop.create_future()

    sink._deliver(content_delta("first"), first)  # noqa: SLF001
    sink._deliver(content_delta("second"), second)  # noqa: SLF001

    second.set_result(20)  # 后发的先落库
    first.set_result(10)

    a = await asyncio.wait_for(sub.get(), timeout=1.0)
    b = await asyncio.wait_for(sub.get(), timeout=1.0)
    assert (a.payload["delta"], a.seq) == ("first", 10)
    assert (b.payload["delta"], b.seq) == ("second", 20)


async def test_seq_is_shared_by_every_subscriber():
    """同一事件在各端拿到同一个 seq（Last-Event-ID 断点对齐）。"""
    sink = EventSink()
    a = sink.subscribe(label="a")
    b = sink.subscribe(label="b")
    loop = asyncio.get_running_loop()
    barrier: asyncio.Future[int | None] = loop.create_future()

    sink._deliver(content_delta("dur"), barrier)  # noqa: SLF001
    barrier.set_result(7)

    assert (await asyncio.wait_for(a.get(), timeout=1.0)).seq == 7
    assert (await asyncio.wait_for(b.get(), timeout=1.0)).seq == 7


async def test_one_subscriber_cancelling_does_not_kill_shared_seq_wait():
    """一端在等 seq 时被取消（断连），另一端仍能拿到带 seq 的同一帧。"""
    sink = EventSink()
    a = sink.subscribe(label="a")
    b = sink.subscribe(label="b")
    loop = asyncio.get_running_loop()
    barrier: asyncio.Future[int | None] = loop.create_future()
    sink._deliver(content_delta("dur"), barrier)  # noqa: SLF001

    doomed = asyncio.ensure_future(a.get())
    await asyncio.sleep(0)  # 让它停在 seq 等待点
    doomed.cancel()
    with pytest.raises(asyncio.CancelledError):
        await doomed

    barrier.set_result(11)
    assert (await asyncio.wait_for(b.get(), timeout=1.0)).seq == 11


async def test_close_with_a_pending_seq_still_drains_the_backlog():
    """收口时 seq 还没落定：帧照发（无 ``id:``），端正常收到哨兵，而不是炸流。"""
    sink = EventSink()
    sub = sink.subscribe()
    loop = asyncio.get_running_loop()
    slow: asyncio.Future[int | None] = loop.create_future()
    stalled: asyncio.Future[int | None] = loop.create_future()
    # 两条 barrier → 走合并器；close 取消合并任务，回填任务随之收敛。
    sink._deliver(  # noqa: SLF001
        content_delta("tail"),
        sink._combine_persist_barriers([slow, stalled]),  # noqa: SLF001
    )
    slow.set_result(1)

    sink.close()
    event = await asyncio.wait_for(sub.get(), timeout=1.0)
    assert event is not None and event.payload["delta"] == "tail"
    assert await asyncio.wait_for(sub.get(), timeout=1.0) is None


# --- 端到端：两条 SSE 并听同一回合 --------------------------------------------


async def test_two_sse_streams_on_one_turn_are_independent(monkeypatch):
    """两条 attach 流同开：同帧；一条断开后另一条继续，回合不被取消。"""
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    sink = EventSink()
    producer = asyncio.create_task(_never())
    first = sse._attach_generator(sink)
    second = sse._attach_generator(sink)
    try:
        for gen in (first, second):
            caught_up = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert caught_up == sse._ATTACH_CAUGHT_UP
        assert sink.subscriber_count == 2

        sink.emit(content_delta("同帧"))
        for gen in (first, second):
            frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
            assert "同帧" in frame

        await first.aclose()  # 一端断开
        assert sink.subscriber_count == 1
        assert not producer.done()  # 回合不受影响

        sink.emit(content_delta("只剩我"))
        frame = await asyncio.wait_for(second.__anext__(), timeout=1.0)
        assert "只剩我" in frame
    finally:
        await second.aclose()
        producer.cancel()


# --- 对话级订阅：空闲不 204，新回合自动续播 -----------------------------------


async def test_hub_publishes_new_run_to_every_watcher():
    hub = ConversationStreamHub()
    a = hub.watch("c-multi")
    b = hub.watch("c-multi")
    other = hub.watch("c-other")
    assert hub.watcher_count("c-multi") == 2

    sink = EventSink()
    assert hub.publish_run("c-multi", sink) == 2
    assert await asyncio.wait_for(a.next_run(), timeout=1.0) is sink
    assert await asyncio.wait_for(b.next_run(), timeout=1.0) is sink
    assert other._runs.empty()  # noqa: SLF001 — 别的对话不受影响

    hub.unwatch(a)
    assert hub.watcher_count("c-multi") == 1
    assert hub.publish_run("c-multi", EventSink()) == 1


async def test_turn_register_publishes_to_conversation_watchers():
    """每个回合起点都走 ``turn_runs.register`` → 停在空闲对话上的端必然收到信号。"""
    from agentcore.runtime.events.conversation_hub import conversation_streams
    from agentcore.runtime.turn.runs import TurnRunRegistry

    watcher = conversation_streams.watch("c-register")
    task = asyncio.create_task(_never())
    try:
        sink = EventSink()
        TurnRunRegistry().register(conversation_id="c-register", task=task, sink=sink)
        assert await asyncio.wait_for(watcher.next_run(), timeout=1.0) is sink
    finally:
        conversation_streams.unwatch(watcher)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def test_conversation_stream_idle_then_picks_up_next_turn(monkeypatch):
    """第二端停在空闲对话上：先只有心跳，另一端起回合后自动收到新回合的帧。"""
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    hub = ConversationStreamHub()
    watcher = hub.watch("c-idle")
    monkeypatch.setattr(sse, "conversation_streams", hub)

    gen = sse._conversation_generator(watcher)
    try:
        # 空闲：不 204、不断流，只有心跳注释帧。
        assert (await asyncio.wait_for(gen.__anext__(), timeout=1.0)).startswith(":")

        sink = EventSink()  # 另一端发消息 → 新回合注册
        hub.publish_run("c-idle", sink)

        caught_up = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert caught_up == sse._ATTACH_CAUGHT_UP
        sink.emit(content_delta("新回合"))
        frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "新回合" in frame

        # 回合收口 → 本端只回到等待态，HTTP 流不断（订阅的是对话，不是回合）。
        sink.emit(message_end(FinishReason.END_TURN, input_tokens=1, output_tokens=1))
        end_frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert EventType.MESSAGE_END.value in end_frame
        sink.close()
        assert (await asyncio.wait_for(gen.__anext__(), timeout=1.0)).startswith(":")

        # 再起一个回合仍然收得到（起回合前就有内容 → 走重放段，同 attach 语义）。
        second_sink = EventSink()
        second_sink.emit(content_delta("第二回合"))
        hub.publish_run("c-idle", second_sink)
        replay = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "第二回合" in replay
        assert await asyncio.wait_for(gen.__anext__(), timeout=1.0) == sse._ATTACH_CAUGHT_UP
        second_sink.close()
    finally:
        await gen.aclose()
    assert hub.watcher_count("c-idle") == 0  # 断开即注销，不漏 watcher


async def test_conversation_stream_delivers_without_waiting_for_the_heartbeat(monkeypatch):
    """新回合 / 帧 / 信号都必须**立刻**送达，不能被压到心跳窗口边界。

    回归 2026-08-13 真跑发现的缺陷：generator 同时等「下个回合」与「有信号」两个 future，
    而空闲对话上后者永不 resolve —— ``asyncio.wait`` 默认 ``ALL_COMPLETED`` 于是把新回合
    一路拖到心跳超时。真机实测第二端晚 **12.6 秒**才看到回合（那时它已经跑完了），拿到的
    还是收口后的 history 快照，逐帧 delta 退化成一块。

    上面几个用例把心跳 patch 成 10ms，等于把这个「只在超时时才返回」的缺陷一起隐形了。
    这里反过来：心跳远大于断言窗口，一旦退回 ``ALL_COMPLETED`` 必然超时。
    """
    from agentcore.runtime.events import turn_queued

    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 30.0)
    hub = ConversationStreamHub()
    monkeypatch.setattr(sse, "conversation_streams", hub)
    watcher = hub.watch("c-nowait")

    gen = sse._conversation_generator(watcher)
    try:
        sink = EventSink()
        hub.publish_run("c-nowait", sink)
        assert await asyncio.wait_for(gen.__anext__(), timeout=1.0) == sse._ATTACH_CAUGHT_UP

        # 跟播中的每一帧同样不能等心跳（`_live_tail` 里是同一个陷阱，且更狠：帧帧都慢）。
        sink.emit(content_delta("立刻"))
        assert "立刻" in await asyncio.wait_for(gen.__anext__(), timeout=1.0)

        # 信号道（队列类短暂态）走的也是这条 ``asyncio.wait``。
        hub.publish_signal(
            "c-nowait",
            turn_queued(queue_id="q1", position=1, queue_depth=1, conversation_id="c-nowait"),
        )
        assert EventType.TURN_QUEUED.value in await asyncio.wait_for(gen.__anext__(), timeout=1.0)
    finally:
        await gen.aclose()


async def test_conversation_stream_replays_run_live_at_connect(monkeypatch):
    """连上来时已有回合在跑：先重放已有内容，再跟播（与 attach 同一段）。"""
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    hub = ConversationStreamHub()
    watcher = hub.watch("c-live")
    monkeypatch.setattr(sse, "conversation_streams", hub)

    sink = EventSink()
    sink.emit(content_delta("已经说了一半"))
    gen = sse._conversation_generator(watcher, initial_sink=sink)
    try:
        replay = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "已经说了一半" in replay
        assert await asyncio.wait_for(gen.__anext__(), timeout=1.0) == sse._ATTACH_CAUGHT_UP

        # 同一个 sink 又被 hub 投递一次（register 与 live 槽查询竞态）→ 不得重挂重放。
        hub.publish_run("c-live", sink)
        sink.emit(content_delta("继续"))
        frame = await asyncio.wait_for(gen.__anext__(), timeout=1.0)
        assert "继续" in frame
        assert sink.subscriber_count == 1
    finally:
        await gen.aclose()
        sink.close()


async def test_conversation_stream_disconnect_leaves_peer_and_run_alone(monkeypatch):
    """对话级订阅断开：只摘自己的订阅与 watcher，另一端与回合都不受影响。"""
    monkeypatch.setattr(sse, "_HEARTBEAT_INTERVAL_S", 0.01)
    hub = ConversationStreamHub()
    monkeypatch.setattr(sse, "conversation_streams", hub)
    sink = EventSink()
    first = sse._conversation_generator(hub.watch("c-peer"), initial_sink=sink)
    second = sse._conversation_generator(hub.watch("c-peer"), initial_sink=sink)
    try:
        for gen in (first, second):
            assert await asyncio.wait_for(gen.__anext__(), timeout=1.0) == sse._ATTACH_CAUGHT_UP
        assert sink.subscriber_count == 2

        await first.aclose()
        assert sink.subscriber_count == 1
        assert hub.watcher_count("c-peer") == 1
        assert not sink.is_closed

        sink.emit(content_delta("活着"))
        frame = await asyncio.wait_for(second.__anext__(), timeout=1.0)
        assert "活着" in frame
    finally:
        await second.aclose()
        sink.close()
