"""EventSink detach/close structured observability (reason + open→closed gate)."""

from __future__ import annotations

import agentcore.runtime.events.sink as sink_mod
from agentcore.runtime.events.sink import EventSink
from tests.conftest import LogSpy


def test_detach_logs_reason_and_already_detached(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c1", message_id="m1")
    sink.detach()  # default reason still works
    first = spy.get("event_sink.detach")
    assert first["reason"] == "unspecified"
    assert first["conversation_id"] == "c1"
    assert first["message_id"] == "m1"
    assert first["already_detached"] is False

    spy.events.clear()
    sink.detach(reason="sse_disconnect")
    second = spy.get("event_sink.detach")
    assert second["reason"] == "sse_disconnect"
    assert second["already_detached"] is True


def test_close_logs_only_open_to_closed_with_was_detached(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(sink_mod, "logger", spy)

    sink = EventSink(conversation_id="c2", message_id="m2")
    sink.detach(reason="sse_disconnect")
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
