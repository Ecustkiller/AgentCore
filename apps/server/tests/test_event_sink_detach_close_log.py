"""EventSink detach/close structured observability (reason + open→closed gate)."""

from __future__ import annotations

import agentcore.observability.drop_heartbeat as drop_hb
import agentcore.runtime.events.sink as sink_mod
from agentcore.runtime.events.chat import content_delta
from agentcore.runtime.events.sink import _SUBSCRIBER_QUEUE_MAXSIZE, EventSink
from tests.conftest import LogSpy


def test_unsubscribe_logs_reason_and_already_detached(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c1", message_id="m1")
    sub = sink.subscribe()
    sink.unsubscribe(sub)  # default reason still works
    first = spy.get("event_sink.detach")
    assert first["reason"] == "unspecified"
    assert first["conversation_id"] == "c1"
    assert first["message_id"] == "m1"
    assert first["already_detached"] is False

    spy.events.clear()
    sink.unsubscribe(sub, reason="sse_disconnect")
    second = spy.get("event_sink.detach")
    assert second["reason"] == "sse_disconnect"
    assert second["already_detached"] is True


def test_note_no_consumer_logs_detach(monkeypatch):
    """Handed off with nobody listening (queue drain / deferred resume) — same event."""
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c3", message_id="m3")
    sink.note_no_consumer(reason="queued_no_waiter")
    logged = spy.get("event_sink.detach")
    assert logged["reason"] == "queued_no_waiter"
    assert logged["already_detached"] is True


def test_close_logs_only_open_to_closed_with_was_detached(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c2", message_id="m2")
    sink.unsubscribe(sink.subscribe(), reason="sse_disconnect")
    spy.events.clear()

    sink.close(reason="turn_finally")
    close_kw = spy.get("event_sink.close")
    assert close_kw["reason"] == "turn_finally"
    assert close_kw["conversation_id"] == "c2"
    assert close_kw["message_id"] == "m2"
    assert close_kw["was_detached"] is True

    spy.events.clear()
    sink.close(reason="turn_finally")  # idempotent — no second log
    assert spy.events == []


def test_close_with_a_peer_still_attached_is_not_detached(monkeypatch):
    """One端 dropping must not make the close look detached while another is listening."""
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c4", message_id="m4")
    first = sink.subscribe(label="a")
    sink.subscribe(label="b")
    sink.unsubscribe(first, reason="sse_disconnect")
    spy.events.clear()

    sink.close(reason="turn_finally")
    assert spy.get("event_sink.close")["was_detached"] is False


def test_backpressure_drop_logs_are_o1(monkeypatch):
    """N shed frames must not write N jsonl lines: first drop + end flush."""
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)
    monkeypatch.setattr(drop_hb, "_now", lambda: 0.0)

    sink = EventSink(conversation_id="c1", message_id="m1")
    sub = sink.subscribe(label="slow")
    extra = 200
    for i in range(_SUBSCRIBER_QUEUE_MAXSIZE + extra):
        sink.emit(content_delta(str(i)))

    drops = [kw for name, kw in spy.events if name == "event_sink.backpressure_drop"]
    assert len(drops) == 1
    assert drops[0]["dropped_delta"] == 1
    assert drops[0]["dropped_total"] == 1
    assert drops[0]["label"] == "slow"
    assert drops[0]["type"] == "content_delta"
    assert drops[0]["conversation_id"] == "c1"
    assert drops[0]["message_id"] == "m1"

    sink.unsubscribe(sub, reason="sse_disconnect")
    drops = [kw for name, kw in spy.events if name == "event_sink.backpressure_drop"]
    assert len(drops) == 2
    assert drops[1]["dropped_delta"] == extra - 1
    assert drops[1]["dropped_total"] == extra
    assert sum(d["dropped_delta"] for d in drops) == extra


def test_close_flushes_remaining_backpressure_drops(monkeypatch):
    """Sink close (no prior unsubscribe) still flushes the drop remainder."""
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)
    monkeypatch.setattr(drop_hb, "_now", lambda: 0.0)

    sink = EventSink(conversation_id="c2", message_id="m2")
    sink.subscribe(label="slow")
    extra = 50
    for i in range(_SUBSCRIBER_QUEUE_MAXSIZE + extra):
        sink.emit(content_delta(str(i)))

    spy.events.clear()
    sink.close(reason="turn_finally")
    drops = [kw for name, kw in spy.events if name == "event_sink.backpressure_drop"]
    assert len(drops) == 1
    assert drops[0]["dropped_delta"] == extra - 1
    assert drops[0]["dropped_total"] == extra


def test_close_without_reason_still_works(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink()
    sink.close()
    kw = spy.get("event_sink.close")
    assert kw["reason"] == "unspecified"
    assert kw["was_detached"] is False
    assert kw["conversation_id"] is None
    assert kw["message_id"] is None
