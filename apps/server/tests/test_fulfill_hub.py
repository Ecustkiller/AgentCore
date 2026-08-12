"""Unit tests for the device-level CLIENT_TOOL fulfillment hub + dispatch.

Covers register / unregister, multi-device selection (most recent), root / caps
matching, queue-full unhealthy close, and ``deliver_client_tool`` outcomes.
No DB, no HTTP — plain async tests (asyncio_mode=auto).
"""

from __future__ import annotations

import asyncio

from agentcore.api.routes.fulfill import _format_event, _fulfill_stream
from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool
from agentcore.fulfill.hub import (
    _FULFILLER_QUEUE_MAXSIZE,
    FulfillerHub,
    FulfillerIdentity,
    FulfillerSession,
    default_fulfiller_hub,
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


async def test_find_prefers_most_recently_registered():
    hub = FulfillerHub()
    older = hub.register("u1", "d1", caps=["workspace"], roots=["r1"])
    await asyncio.sleep(0.01)
    newer = hub.register("u1", "d2", caps=["workspace"], roots=["r1"])
    assert hub.find("u1", root_id="r1", channel="workspace") is newer
    hub.unregister(newer)
    assert hub.find("u1", root_id="r1", channel="workspace") is older


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


async def test_find_root_none_matches_any_capable():
    hub = FulfillerHub()
    hub.register("u1", "d1", caps=["notify"], roots=[])
    assert hub.find("u1", root_id=None, channel="notify") is not None
    assert hub.has_fulfiller("u1", root_id=None, channel="notify") is True
    assert hub.has_fulfiller("u1", root_id="r1", channel="notify") is False


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


async def test_deliver_retries_after_queue_full_close():
    """A stuck device is closed; a healthy peer still receives the frame."""
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
