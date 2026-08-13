"""Unit tests for the device-level CLIENT_TOOL fulfillment hub + dispatch.

Covers register / unregister, multi-device selection (origin device first, then
most recent), root / caps matching, queue-full unhealthy close, and
``deliver_client_tool`` outcomes including the origin pin that keeps disk /
command ops on the machine that started the turn, and the three-way naming of a
selection miss (origin offline / root not held / no fulfiller) that a log read
has to be able to tell apart.
No DB, no HTTP — plain async tests (asyncio_mode=auto).
"""

from __future__ import annotations

import asyncio

from agentcore.api.routes.fulfill import _format_event, _fulfill_stream
from agentcore.fulfill import dispatch
from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool
from agentcore.fulfill.hub import (
    _FULFILLER_QUEUE_MAXSIZE,
    ORIGIN_PINNED_CHANNELS,
    FulfillerHub,
    FulfillerIdentity,
    FulfillerSession,
    default_fulfiller_hub,
    origin_pinned,
)
from agentcore.runtime.events.types import EventType, SSEEvent


def test_default_fulfiller_hub_is_singleton():
    assert default_fulfiller_hub() is default_fulfiller_hub()


async def test_register_and_unregister():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    assert hub.connection_count("u1") == 1
    assert hub.get_session("u1", "d1") is session

    hub.unregister(session)
    assert hub.connection_count("u1") == 0
    assert hub.get_session("u1", "d1") is None


async def test_reregister_same_device_replaces_session():
    hub = FulfillerHub()
    old = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    new = hub.register("u1", "d1", caps=["workspace", "host"], roots=["r2"])
    assert old is not new
    assert hub.get_session("u1", "d1") is new
    assert hub.connection_count("u1") == 1
    assert "host" in new.caps
    assert new.roots == {"r2"}
    # Old session was closed (sentinel delivered).
    assert await old.get() is None


async def test_find_prefers_origin_device_over_most_recent():
    """The turn's own device wins; recency only breaks ties without one."""
    hub = FulfillerHub()
    older = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    await asyncio.sleep(0.01)
    newer = hub.register("u1", "d2", caps=["workspace"], roots=["r1"])

    assert hub.find("u1", root_id="r1", channel="workspace") is newer
    assert (
        hub.find("u1", root_id="r1", channel="workspace", origin_device_id="d1")
        is older
    )
    hub.unregister(newer)
    assert hub.find("u1", root_id="r1", channel="workspace") is older


async def test_find_falls_back_to_most_recent_when_origin_is_gone():
    """Preference only — an offline origin must not blank out an unpinned pick."""
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["notify"], roots=[])
    await asyncio.sleep(0.01)
    newer = hub.register("u1", "d2", caps=["notify"], roots=[])

    assert (
        hub.find("u1", root_id=None, channel="notify", origin_device_id="gone")
        is newer
    )


async def test_find_require_origin_refuses_a_peer():
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["host"], roots=[])
    origin = hub.register("u1", "d2", caps=["host"], roots=[])

    assert (
        hub.find(
            "u1",
            root_id=None,
            channel="host",
            origin_device_id="d2",
            require_origin=True,
        )
        is origin
    )
    hub.unregister(origin)
    assert (
        hub.find(
            "u1",
            root_id=None,
            channel="host",
            origin_device_id="d2",
            require_origin=True,
        )
        is None
    )
    # Unknown origin cannot be pinned to anything — old behavior stands.
    assert (
        hub.find("u1", root_id=None, channel="host", require_origin=True) is not None
    )


def test_origin_pin_covers_machine_acting_channels_only():
    assert sorted(ORIGIN_PINNED_CHANNELS) == [
        "external_mount",
        "host",
        "mcp",
        "workspace",
    ]
    for channel in ORIGIN_PINNED_CHANNELS:
        assert origin_pinned(channel, root_id=None) is True
        # A root already names one install — that location logic is untouched.
        assert origin_pinned(channel, root_id="r1") is False
    for channel in ("board", "board_read", "notify"):
        assert origin_pinned(channel, root_id=None) is False


async def test_find_requires_cap_and_root():
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    hub.register("u1", "d2", caps=["host"], roots=["r1"])
    hub.register("u1", "d3", caps=["workspace"], roots=["r2"])

    assert hub.find("u1", root_id="r1", channel="workspace").device_id == "d1"
    assert hub.find("u1", root_id="r1", channel="host").device_id == "d2"
    assert hub.find("u1", root_id="r2", channel="workspace").device_id == "d3"
    assert hub.find("u1", root_id="r1", channel="mcp") is None
    assert hub.find("u1", root_id="missing", channel="workspace") is None


async def test_find_root_none_matches_any_capable_unless_pinned():
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["notify", "host"], roots=[])
    assert hub.find("u1", root_id=None, channel="notify") is not None
    assert hub.has_fulfiller("u1", root_id=None, channel="notify") is True
    assert hub.has_fulfiller("u1", root_id="r1", channel="notify") is False
    # Same rootless lookup, but a pinned channel from another device: absent.
    assert (
        hub.has_fulfiller(
            "u1",
            root_id=None,
            channel="host",
            origin_device_id="other",
            require_origin=True,
        )
        is False
    )


async def test_update_roots_without_reconnect():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    assert hub.update_roots("u1", "d1", ["r2", "r3"]) is True
    assert session.roots == {"r2", "r3"}
    assert hub.find("u1", root_id="r1", channel="workspace") is None
    assert hub.find("u1", root_id="r2", channel="workspace") is session
    assert hub.update_roots("u1", "missing", ["r9"]) is False


async def test_queue_full_closes_session():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])

    for i in range(_FULFILLER_QUEUE_MAXSIZE):
        assert session.offer({"type": "m", "i": i}) is True

    assert hub.deliver(session, {"type": "overflow"}) is False
    assert hub.get_session("u1", "d1") is None
    assert hub.connection_count("u1") == 0
    # Closed session surfaces the sentinel (backlog drained on close).
    assert await session.get() is None


async def test_deliver_client_tool_no_fulfiller():
    hub = FulfillerHub()
    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {}},
        hub=hub,
    )
    assert result is DeliverResult.NO_FULFILLER


async def test_deliver_root_not_held_when_the_desktop_holds_another_root():
    """Desktop online, this root not declared: the gate's case 2, mid-turn."""
    hub = FulfillerHub()
    holder = hub.register("u1", "d1", caps=["workspace"], roots=["other-root"])

    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "read"}},
        hub=hub,
    )
    assert result is DeliverResult.ROOT_NOT_HELD
    # The root stays an authorization boundary — nothing was handed to d1.
    assert holder._queue.qsize() == 0


async def test_deliver_no_fulfiller_when_the_online_device_lacks_the_channel():
    """A device without the workspace cap is no desktop at all for this op."""
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["notify"], roots=["r1"])

    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "read"}},
        hub=hub,
    )
    assert result is DeliverResult.NO_FULFILLER


async def test_no_fulfiller_log_says_which_of_the_three_states(monkeypatch):
    """A ``no fulfiller`` line must be readable after the fact, not a shrug."""
    from tests.conftest import LogSpy

    spy = LogSpy()
    monkeypatch.setattr(dispatch, "logger", spy)
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["workspace"], roots=["other-root"])

    deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "read"}},
        hub=hub,
    )
    fields = spy.get("fulfill.no_fulfiller")
    assert fields["reason"] == "root_not_held"
    assert fields["root_id"] == "r1"
    assert fields["channel"] == "workspace"
    assert fields["devices"] == 1

    spy.events.clear()
    deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "read"}},
        hub=FulfillerHub(),
    )
    offline = spy.get("fulfill.no_fulfiller")
    assert offline["reason"] == "desktop_offline"
    assert offline["devices"] == 0

    # Third state keeps its own line (origin device gone, peer still online).
    spy.events.clear()
    pinned_hub = FulfillerHub()
    pinned_hub.register("u1", "peer", caps=["host"], roots=[])
    deliver_client_tool(
        "u1",
        "c1",
        "host",
        None,
        {"type": "host_op_required", "payload": {"op": "host_shell"}},
        origin_device_id="gone",
        hub=pinned_hub,
    )
    assert spy.get("fulfill.origin_offline")["reason"] == "not_online"


async def test_deliver_client_tool_delivered():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    event = SSEEvent(
        type=EventType.WORKSPACE_OP_REQUIRED,
        payload={"request_id": "req1", "root_id": "r1", "op": "exists"},
    )
    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        event,
        hub=hub,
    )
    assert result is DeliverResult.DELIVERED
    got = await session.get()
    assert got["type"] == "workspace_op_required"
    assert got["payload"]["request_id"] == "req1"


async def test_deliver_retries_after_queue_full_close_when_unpinned():
    """No pin in force: a stuck device is closed and a healthy peer takes it."""
    hub = FulfillerHub()
    stuck = hub.register("u1", "stuck", caps=["workspace"], roots=["r1"])
    await asyncio.sleep(0.01)
    healthy = hub.register("u1", "ok", caps=["workspace"], roots=["r1"])
    # Fill the newer (preferred) session so deliver closes it and falls back.
    for i in range(_FULFILLER_QUEUE_MAXSIZE):
        assert healthy.offer({"type": "pad", "i": i}) is True

    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "ping"}},
        hub=hub,
    )
    assert result is DeliverResult.DELIVERED
    assert hub.get_session("u1", "ok") is None
    got = await stuck.get()
    assert got["type"] == "workspace_op_required"


async def test_deliver_does_not_retry_onto_a_peer_when_pinned():
    """Queue-full on the origin must not hand a rootless disk op to another machine."""
    hub = FulfillerHub()
    peer = hub.register("u1", "peer", caps=["workspace"], roots=[])
    origin = hub.register("u1", "origin", caps=["workspace"], roots=[])
    for i in range(_FULFILLER_QUEUE_MAXSIZE):
        assert origin.offer({"type": "pad", "i": i}) is True

    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        None,
        {"type": "workspace_op_required", "payload": {"op": "ping"}},
        origin_device_id="origin",
        hub=hub,
    )
    assert result is DeliverResult.ORIGIN_OFFLINE
    # Unhealthy origin still got closed; the peer was left untouched.
    assert hub.get_session("u1", "origin") is None
    assert hub.get_session("u1", "peer") is peer
    assert peer._queue.qsize() == 0


async def test_two_devices_pinned_op_lands_on_the_origin_device():
    hub = FulfillerHub()
    origin = hub.register("u1", "A", caps=["host"], roots=[])
    await asyncio.sleep(0.01)
    # B registered later — the pre-pin rule would have chosen it.
    other = hub.register("u1", "B", caps=["host"], roots=[])

    result = deliver_client_tool(
        "u1",
        "c1",
        "host",
        None,
        {"type": "host_op_required", "payload": {"op": "host_shell"}},
        origin_device_id="A",
        hub=hub,
    )
    assert result is DeliverResult.DELIVERED
    got = await origin.get()
    assert got["payload"]["op"] == "host_shell"
    assert other._queue.qsize() == 0


async def test_two_devices_pinned_op_errors_when_origin_left():
    """A goes offline: the shell command must not run on B instead."""
    hub = FulfillerHub()
    origin = hub.register("u1", "A", caps=["host"], roots=[])
    other = hub.register("u1", "B", caps=["host"], roots=[])
    hub.unregister(origin)

    result = deliver_client_tool(
        "u1",
        "c1",
        "host",
        None,
        {"type": "host_op_required", "payload": {"op": "host_shell"}},
        origin_device_id="A",
        hub=hub,
    )
    assert result is DeliverResult.ORIGIN_OFFLINE
    assert other._queue.qsize() == 0


async def test_two_devices_reminder_still_reaches_the_remaining_one():
    """Display / reminder channels keep the old any-capable-device behavior."""
    hub = FulfillerHub()
    origin = hub.register("u1", "A", caps=["notify"], roots=[])
    other = hub.register("u1", "B", caps=["notify"], roots=[])
    hub.unregister(origin)

    result = deliver_client_tool(
        "u1",
        "c1",
        "notify",
        None,
        {"type": "desktop_notify_required", "payload": {"title": "t"}},
        origin_device_id="A",
        hub=hub,
    )
    assert result is DeliverResult.DELIVERED
    got = await other.get()
    assert got["type"] == "desktop_notify_required"


async def test_single_device_pinned_op_keeps_the_no_fulfiller_answer():
    """One install, offline: 'no fulfiller', not 'your other device is gone'."""
    hub = FulfillerHub()
    result = deliver_client_tool(
        "u1",
        "c1",
        "host",
        None,
        {"type": "host_op_required", "payload": {"op": "host_info"}},
        origin_device_id="A",
        hub=hub,
    )
    assert result is DeliverResult.NO_FULFILLER


async def test_rooted_op_ignores_the_pin():
    """Root-bound location logic is unchanged: the root still decides."""
    hub = FulfillerHub()
    holder = hub.register("u1", "B", caps=["workspace"], roots=["r1"])

    result = deliver_client_tool(
        "u1",
        "c1",
        "workspace",
        "r1",
        {"type": "workspace_op_required", "payload": {"op": "read"}},
        origin_device_id="A",
        hub=hub,
    )
    assert result is DeliverResult.DELIVERED
    assert (await holder.get())["type"] == "workspace_op_required"


async def test_unknown_caps_filtered_on_register():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace", "not_a_channel"], roots=[])
    assert session.caps == frozenset({"workspace"})


def test_format_event_is_named_sse_frame():
    frame = _format_event({"type": "workspace_op_required", "payload": {"op": "x"}})
    assert frame.startswith("event: workspace_op_required\n")
    assert '"op": "x"' in frame
    assert frame.endswith("\n\n")


async def test_fulfill_stream_ready_then_event_and_unregisters():
    hub = FulfillerHub()
    session = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    gen = _fulfill_stream(session, hub)

    first = await gen.__anext__()
    assert first.startswith("event: ready\n")

    assert hub.deliver(session, {"type": "client_tool_cancelled", "payload": {"request_id": "r"}})
    second = await gen.__anext__()
    assert second.startswith("event: client_tool_cancelled\n")

    await gen.aclose()
    assert hub.connection_count("u1") == 0


async def test_session_aiter_ends_on_close():
    session = FulfillerSession(
        FulfillerIdentity(
            user_id="u1",
            device_id="d1",
            platform=None,
            caps=frozenset({"workspace"}),
        ),
        registered_at=0.0,
    )
    await session._queue.put({"type": "a"})
    session.close()
    seen = [event async for event in session]
    assert seen == []
