"""DropLogHeartbeat: first drop logs immediately, then count/time heartbeat + flush."""

from __future__ import annotations

import agentcore.observability.drop_heartbeat as drop_hb
from agentcore.observability.drop_heartbeat import DropLogHeartbeat


def test_first_drop_emits_immediately():
    h = DropLogHeartbeat(every=1000, interval_s=60.0)
    pulse = h.note("content_delta")
    assert pulse is not None
    assert pulse.dropped_delta == 1
    assert pulse.dropped_total == 1
    assert pulse.event_type == "content_delta"


def test_subsequent_drops_are_silent_until_flush(monkeypatch):
    monkeypatch.setattr(drop_hb, "_now", lambda: 0.0)
    h = DropLogHeartbeat(every=1000, interval_s=1.0)
    assert h.note("m") is not None
    n = 200
    silent = 0
    for _ in range(n - 1):
        if h.note("m") is None:
            silent += 1
    assert silent == n - 1
    flushed = h.flush()
    assert flushed is not None
    assert flushed.dropped_delta == n - 1
    assert flushed.dropped_total == n
    assert h.flush() is None


def test_count_heartbeat_fires_every_n(monkeypatch):
    monkeypatch.setattr(drop_hb, "_now", lambda: 0.0)
    h = DropLogHeartbeat(every=3, interval_s=60.0)
    assert h.note("m") is not None  # first
    assert h.note("m") is None
    assert h.note("m") is None
    pulse = h.note("m")
    assert pulse is not None
    assert pulse.dropped_delta == 3
    assert pulse.dropped_total == 4


def test_time_heartbeat_fires_after_interval(monkeypatch):
    t = {"now": 0.0}
    monkeypatch.setattr(drop_hb, "_now", lambda: t["now"])
    h = DropLogHeartbeat(every=1000, interval_s=1.0)
    assert h.note("m") is not None
    assert h.note("m") is None
    t["now"] = 0.99
    assert h.note("m") is None
    t["now"] = 1.0
    pulse = h.note("m")
    assert pulse is not None
    assert pulse.dropped_delta == 3
    assert pulse.dropped_total == 4
