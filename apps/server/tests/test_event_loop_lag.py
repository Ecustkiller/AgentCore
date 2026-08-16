"""Event-loop lag window: warn on stall, summarize on interval, cancel cleanly."""

from __future__ import annotations

import asyncio

import pytest

from agentcore.observability.event_loop_lag import LagWindow, event_loop_lag_loop
from tests.conftest import LogSpy


def test_lag_window_warns_above_threshold_and_summarizes():
    window = LagWindow(
        interval_s=1.0, warn_lag_s=0.25, summary_s=60.0, warn_repeat_s=10.0
    )
    window._window_started_mono = 0.0
    assert window.note(0.01, now_mono=0.0) == []

    stall = window.note(1.5, now_mono=1.0)
    assert len(stall) == 1
    assert stall[0].event == "event_loop.lag"
    assert stall[0].payload["lag_ms"] == 1500
    assert stall[0].payload["suppressed"] == 0

    assert window.note(0.4, now_mono=2.0) == []
    assert window.note(0.3, now_mono=3.0) == []

    later = window.note(0.5, now_mono=11.0)
    assert len(later) == 1
    assert later[0].event == "event_loop.lag"
    assert later[0].payload["suppressed"] == 2

    rolled = window.note(0.0, now_mono=60.0)
    assert [p.event for p in rolled] == ["event_loop.lag_summary"]
    assert rolled[0].payload["max_lag_ms"] == 1500
    assert rolled[0].payload["over_threshold"] == 4


async def test_lag_loop_cancels_without_summary(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr("agentcore.observability.event_loop_lag.logger", spy)
    task = asyncio.create_task(
        event_loop_lag_loop(interval_s=60.0, warn_lag_s=0.25, summary_s=3600.0)
    )
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert spy.events == []


async def test_lag_loop_cancel_does_not_flush_a_false_shutdown_stall(monkeypatch):
    """Salvage busy-loop must not become a leftover lag / lag_summary line."""
    spy = LogSpy()
    monkeypatch.setattr("agentcore.observability.event_loop_lag.logger", spy)
    task = asyncio.create_task(
        event_loop_lag_loop(interval_s=0.05, warn_lag_s=0.001, summary_s=0.05)
    )
    await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert all(name != "event_loop.lag_summary" for name, _ in spy.events)
