"""conversation_stream.watch / unwatch are info-level and carry idle timing."""

from __future__ import annotations

import agentcore.runtime.events.conversation_hub as hub_mod
from agentcore.runtime.events.conversation_hub import ConversationStreamHub
from tests.conftest import LogSpy


def test_watch_and_unwatch_log_info_with_idle_and_duration(monkeypatch):
    spy = LogSpy()
    monkeypatch.setattr(hub_mod, "logger", spy)
    clock = {"t": 500.0}
    monkeypatch.setattr(hub_mod, "mono_now", lambda: clock["t"])

    hub = ConversationStreamHub()
    watcher = hub.watch("c-obs")
    start = spy.get("conversation_stream.watch")
    assert start["conversation_id"] == "c-obs"
    assert start["watchers"] == 1
    assert start["mode"] == "follow"
    assert isinstance(start["started_at"], str)

    clock["t"] = 515.0
    watcher.note_byte()
    clock["t"] = 575.0
    hub.unwatch(watcher)

    end = spy.get("conversation_stream.unwatch")
    assert end["conversation_id"] == "c-obs"
    assert end["duration_ms"] == 75_000
    assert end["idle_ms"] == 60_000
    assert end["started_at"] == start["started_at"]
