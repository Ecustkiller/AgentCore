"""Drive-level run-stop (只停这项工作): cancel worker(s) without hot/cold follow-up;
drive converges; CEO (delegate) returns; turn/FIFO untouched.
"""

from __future__ import annotations

import asyncio

from agentcore.llm.provider.protocol import LLMChunk
from agentcore.runtime.events import EventSink
from agentcore.runtime.events.types import EventType
from agentcore.runtime.runs.stop_queue import enqueue_stop, take_stops
from agentcore.runtime.turn.queue import new_queued_turn, turn_queue
from tests.delegate.conftest import ctx, tool


class _SlowProvider:
    """Every original worker sleeps so a mid-flight stop can land; survivors finish."""

    async def stream(self, request):  # noqa: ANN001
        await asyncio.sleep(0.5)
        yield LLMChunk(delta_content="ORIG_DONE")


class _StopOnStartSink(EventSink):
    """Enqueue stop for the first started worker (or stop-all)."""

    def __init__(self, *, stop_all: bool = False) -> None:
        super().__init__()
        self._sent = False
        self._stop_all = stop_all
        self.stopped_run_id = ""
        self.cancelled_reasons: list[str] = []

    def emit(self, event) -> None:  # noqa: ANN001
        if event.type is EventType.RUN_CANCELLED:
            self.cancelled_reasons.append(str(event.payload.get("reason") or ""))
        if not self._sent and event.type is EventType.RUN_STARTED:
            run_id = str(event.payload.get("run_id") or "")
            if run_id and "_rev" not in run_id and not run_id.endswith("_redir"):
                self.stopped_run_id = run_id
                enqueue_stop(
                    execution_id="e",
                    run_id=None if self._stop_all else run_id,
                    conversation_id="c",
                )
                self._sent = True
        super().emit(event)


def _assert_no_followup(history) -> None:  # noqa: ANN001
    redir = [
        e
        for e in history
        if e.type is EventType.RUN_STARTED
        and (
            str(e.payload.get("run_id") or "").endswith("_redir")
            or "_rev" in str(e.payload.get("run_id") or "")
            or e.payload.get("replaces_run_id")
            or e.payload.get("continues_run_id")
        )
    ]
    assert redir == []


async def test_stop_one_worker_leaves_sibling_and_returns_to_ceo():
    """停单个：目标 run_cancelled(user_stop)；兄弟完成；delegate 成功；无续派节点。"""
    take_stops("e")
    sink = _StopOnStartSink(stop_all=False)
    t = tool(_SlowProvider(), sink)

    result = await t.execute(
        {
            "tasks": [
                {"id": "a", "role": "研究员", "task": "并行调研甲"},
                {"id": "b", "role": "编辑", "task": "并行撰写乙"},
            ],
            "coordinate": False,
        },
        ctx(),
    )

    assert result.success is True
    assert "ORIG_DONE" in result.output
    assert "user_stop" in sink.cancelled_reasons
    assert "redirect" not in sink.cancelled_reasons
    assert "stop" not in sink.cancelled_reasons
    _assert_no_followup(sink._history)
    cancelled_msg_end = [
        e
        for e in sink._history
        if e.type is EventType.MESSAGE_END
        and str(e.payload.get("finish_reason") or "") == "cancelled"
    ]
    assert cancelled_msg_end == []


async def test_stop_all_cancels_inflight_without_followup():
    """停全部：在飞均 user_stop；无热/冷续派；delegate 仍收敛返回。"""
    take_stops("e")
    sink = _StopOnStartSink(stop_all=True)
    t = tool(_SlowProvider(), sink)

    result = await t.execute(
        {
            "tasks": [
                {"id": "a", "role": "研究员", "task": "并行调研甲"},
                {"id": "b", "role": "编辑", "task": "并行撰写乙"},
            ],
            "coordinate": False,
        },
        ctx(),
    )

    assert result.success is True
    assert sink.cancelled_reasons.count("user_stop") >= 1
    assert "redirect" not in sink.cancelled_reasons
    _assert_no_followup(sink._history)


async def test_stop_pending_withdraws_as_skipped():
    """未开跑节点被 stop → run_skipped(abort)，executor 不跑它。"""
    take_stops("e")

    class _CountingProvider:
        def __init__(self) -> None:
            self.calls = 0

        async def stream(self, request):  # noqa: ANN001
            self.calls += 1
            await asyncio.sleep(0.45)
            yield LLMChunk(delta_content="FIRST_DONE")

    class _StopAllAfterFirstStart(EventSink):
        def __init__(self) -> None:
            super().__init__()
            self._sent = False
            self.skipped: list[str] = []
            self.cancelled: list[str] = []

        def emit(self, event) -> None:  # noqa: ANN001
            if event.type is EventType.RUN_SKIPPED:
                self.skipped.append(str(event.payload.get("reason") or ""))
            if event.type is EventType.RUN_CANCELLED:
                self.cancelled.append(str(event.payload.get("reason") or ""))
            if not self._sent and event.type is EventType.RUN_STARTED:
                enqueue_stop(execution_id="e", run_id=None, conversation_id="c")
                self._sent = True
            super().emit(event)

    provider = _CountingProvider()
    sink = _StopAllAfterFirstStart()
    t = tool(provider, sink)
    # max_parallel=1 so the second stays queued when stop-all drains.
    t._max_parallel = 1

    result = await t.execute(
        {
            "tasks": [
                {"id": "a", "role": "研究员", "task": "先跑"},
                {"id": "b", "role": "编辑", "task": "后跑"},
            ],
            "coordinate": False,
        },
        ctx(),
    )

    assert result.success is True
    assert "abort" in sink.skipped
    assert "user_stop" in sink.cancelled
    _assert_no_followup(sink._history)
    assert provider.calls <= 1


async def test_run_stop_does_not_clear_fifo_or_abort_turn():
    """回合与 FIFO 不受影响：enqueue stop 不 clear turn_queue。"""
    take_stops("e")
    conv = "conv-run-stop-fifo"
    turn_queue.clear(conv)
    item = new_queued_turn(
        content="queued next",
        user_id="u-test",
        attachments=[],
        agent_mentions=[],
    )
    turn_queue.enqueue(conv, item)
    assert turn_queue.depth(conv) == 1

    sink = _StopOnStartSink(stop_all=False)
    t = tool(_SlowProvider(), sink)
    result = await t.execute(
        {
            "tasks": [
                {"id": "a", "role": "研究员", "task": "并行调研甲"},
                {"id": "b", "role": "编辑", "task": "并行撰写乙"},
            ],
            "coordinate": False,
        },
        ctx(),
    )
    assert result.success is True
    assert turn_queue.depth(conv) == 1
    turn_queue.clear(conv)
