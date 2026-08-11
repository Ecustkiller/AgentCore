"""Local-mode worker gating tests."""

import asyncio

from agentcore.runtime.coordination.session import (
    active_coordination,
    clear_active_coordination,
)
from agentcore.runtime.events import EventSink, EventType
from tests.delegate.conftest import (
    Provider,
    capture_gate,
    ctx,
    gate,
    local_ctx,
    tool,
    tool_with_gate,
)


async def _await_solo_drive() -> None:
    """Solo 默认进协调：须等后台 drive 跑完，gate / lifecycle 才落定。"""
    session = active_coordination("e")
    if session is not None and session.drive_task is not None:
        await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination("e")


async def test_workers_gated_in_local_mode(monkeypatch):
    # Skip kickoff so the executor path runs (gate forwarding is what we assert).
    monkeypatch.setattr(
        "agentcore.runtime.delegate.preview.should_kickoff",
        lambda *a, **k: False,
    )
    clear_active_coordination()
    captured = capture_gate(monkeypatch)
    g = gate()
    t = tool_with_gate(local_ctx(), g)
    await t.execute({"tasks": [{"role": "A", "task": "a"}]}, local_ctx())
    await _await_solo_drive()
    assert captured["gate"] is g


async def test_workers_ungated_in_cloud_mode(monkeypatch):
    clear_active_coordination()
    captured = capture_gate(monkeypatch)
    t = tool_with_gate(ctx(), gate())
    await t.execute({"tasks": [{"role": "A", "task": "a"}]}, ctx())
    await _await_solo_drive()
    assert captured["gate"] is None


async def test_second_call_namespaces_run_ids():
    # 阻塞臂：同回合二次合入仍为新节点铸独立 run_id（默认协调臂会提前返回，事件未齐）。
    sink = EventSink()
    t = tool(Provider(["X", "Y"]), sink=sink)
    await t.execute({"tasks": [{"role": "A", "task": "a"}], "coordinate": False}, ctx())
    await t.execute({"tasks": [{"role": "B", "task": "b"}], "coordinate": False}, ctx())
    sink.close()
    starts = [e async for e in sink if e.type == EventType.RUN_STARTED]
    run_ids = [e.payload["run_id"] for e in starts]
    assert len(run_ids) == 2
    assert run_ids[0] != run_ids[1]
