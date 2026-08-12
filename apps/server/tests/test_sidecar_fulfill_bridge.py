"""本机引擎（sidecar）自带履约方：进程内中枢注册 + 帧走 stdio 直投桌面。

Covers the seam that made every native-mode CLIENT_TOOL fail with
「no fulfiller（无履约方）」: the channels deliver through the in-process
:class:`FulfillerHub`, which had a registration point only on the cloud
``GET /v1/fulfill`` route.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool
from agentcore.fulfill.hub import FULFILL_CHANNELS, FulfillerHub
from agentcore.runtime.events.client_tool_reattach import (
    CHANNEL_BOARD,
    CHANNEL_BOARD_READ,
    CHANNEL_EXTERNAL_MOUNT,
    CHANNEL_HOST,
    CHANNEL_MCP,
    CHANNEL_NOTIFY,
    CHANNEL_WORKSPACE,
    push_client_tool_required,
)
from agentcore.runtime.events.desktop import host_op_required
from agentcore.runtime.interaction import InteractionKind, InteractionRegistry
from agentcore.sidecar.fulfill_bridge import FULFILL_FRAME_METHOD, SidecarFulfillBridge

# conftest patches fulfill delivery to always succeed; this suite asserts the
# real routing (does the sidecar session actually receive the frame?).
pytestmark = pytest.mark.real_fulfill_dispatch

USER = "u-sidecar"
CID = "c-sidecar"


class Link:
    """Stand-in for ``SidecarServer._send`` (the stdio JSON-RPC line sender)."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.arrived = asyncio.Event()

    async def __call__(self, message: dict[str, Any]) -> None:
        self.sent.append(message)
        self.arrived.set()

    async def next_frame(self, timeout: float = 1.0) -> dict[str, Any]:
        await asyncio.wait_for(self.arrived.wait(), timeout)
        self.arrived.clear()
        message = self.sent[-1]
        assert message["method"] == FULFILL_FRAME_METHOD
        frame = message["params"]["event"]
        assert isinstance(frame, dict)
        return frame


@pytest.fixture
def hub() -> FulfillerHub:
    return FulfillerHub()


@pytest.fixture
def link() -> Link:
    return Link()


@pytest.fixture
def bridge(hub: FulfillerHub, link: Link):
    b = SidecarFulfillBridge(link, hub=hub, device_id="dev-sidecar")
    yield b
    b.close()


async def test_bind_user_registers_every_channel(bridge, hub: FulfillerHub) -> None:
    bridge.bind_user(USER)

    session = hub.get_session(USER, "dev-sidecar")
    assert session is not None
    assert session.caps == FULFILL_CHANNELS
    assert session.platform == "sidecar"
    # 未绑定根：无根 op（host/mcp/notify/board/board_read/external_mount/terminal）即可履约。
    assert session.roots == set()


@pytest.mark.parametrize(
    "channel",
    [
        CHANNEL_HOST,
        CHANNEL_MCP,
        CHANNEL_NOTIFY,
        CHANNEL_BOARD,
        CHANNEL_BOARD_READ,
        CHANNEL_EXTERNAL_MOUNT,
        CHANNEL_WORKSPACE,
    ],
)
async def test_all_channels_reach_the_local_fulfiller(
    bridge, hub: FulfillerHub, channel: str
) -> None:
    bridge.bind_user(USER)

    status = deliver_client_tool(
        USER,
        CID,
        channel,
        None,
        host_op_required(request_id="r1", conversation_id=CID, op="host_shell", args={}),
        hub=hub,
    )

    assert status is DeliverResult.DELIVERED


async def test_frame_is_pushed_onto_the_stdio_link(
    bridge, hub: FulfillerHub, link: Link
) -> None:
    bridge.bind_user(USER)

    deliver_client_tool(
        USER,
        CID,
        CHANNEL_HOST,
        None,
        host_op_required(
            request_id="r-push", conversation_id=CID, op="host_shell", args={"command": "ls"}
        ),
        hub=hub,
    )

    frame = await link.next_frame()
    assert frame["type"] == "host_op_required"
    assert frame["payload"]["request_id"] == "r-push"
    assert frame["payload"]["conversation_id"] == CID


async def test_push_client_tool_required_no_longer_settles_no_fulfiller(
    bridge, hub: FulfillerHub, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The engine-facing seam: with a bound bridge the op stays pending (真能履约)."""
    monkeypatch.setattr(
        "agentcore.fulfill.dispatch.default_fulfiller_hub", lambda: hub, raising=True
    )
    bridge.bind_user(USER)
    registry = InteractionRegistry()
    fut = registry.create("r-seam", CID, kind=InteractionKind.CLIENT_TOOL, payload={})

    delivered = push_client_tool_required(
        user_id=USER,
        conversation_id=CID,
        channel=CHANNEL_HOST,
        root_id=None,
        event=host_op_required(
            request_id="r-seam", conversation_id=CID, op="host_shell", args={}
        ),
        registry=registry,
        request_id="r-seam",
        error_kind="HostOpError",
        error_detail="no fulfiller（无履约方）",
    )

    assert delivered is True
    assert not fut.done()


async def test_root_scoped_workspace_needs_a_declared_root(
    bridge, hub: FulfillerHub
) -> None:
    bridge.bind_user(USER)

    def deliver() -> DeliverResult:
        return deliver_client_tool(
            USER,
            CID,
            CHANNEL_WORKSPACE,
            "root-1",
            host_op_required(request_id="r-w", conversation_id=CID, op="read", args={}),
            hub=hub,
        )

    assert deliver() is DeliverResult.NO_FULFILLER
    bridge.declare_root("root-1")
    assert deliver() is DeliverResult.DELIVERED


async def test_rebinding_a_new_account_moves_the_session(
    bridge, hub: FulfillerHub
) -> None:
    """Probe-spawned sidecars initialize as ``local``; the turn brings the real id."""
    bridge.bind_user("local")
    bridge.declare_root("root-1")
    bridge.bind_user(USER)

    assert hub.get_session("local", "dev-sidecar") is None
    assert hub.has_fulfiller("local", root_id=None, channel=CHANNEL_HOST) is False
    assert hub.has_fulfiller(USER, root_id="root-1", channel=CHANNEL_WORKSPACE) is True


async def test_close_removes_the_fulfiller(bridge, hub: FulfillerHub) -> None:
    bridge.bind_user(USER)
    bridge.close()

    assert hub.get_session(USER, "dev-sidecar") is None
    assert hub.has_fulfiller(USER, root_id=None, channel=CHANNEL_HOST) is False
