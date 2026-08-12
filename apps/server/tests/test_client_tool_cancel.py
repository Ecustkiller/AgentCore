"""服务端 ``client_tool_cancelled`` producer：停止能中断已下发的本机 op。

Without this, hitting stop only drops the awaiter — a ``host_shell`` already
dispatched to the user's machine runs to completion with nobody listening.
"""

from __future__ import annotations

import asyncio
from collections.abc import Iterator

import pytest

from agentcore.fulfill.hub import FULFILL_CHANNELS, FulfillerHub, FulfillerSession
from agentcore.runtime.events.client_tool_reattach import (
    CHANNEL_HOST,
    cancel_pending_client_tools,
    client_tool_payload,
)
from agentcore.runtime.events.types import EventType
from agentcore.runtime.interaction import (
    InteractionKind,
    InteractionRegistry,
    default_interaction_registry,
)

# conftest patches fulfill delivery to always succeed (channel round trips need
# it); this suite asserts who actually received the frame, so opt out.
pytestmark = pytest.mark.real_fulfill_dispatch

USER = "u-cancel"
CID = "c-cancel"


@pytest.fixture
def hub(monkeypatch: pytest.MonkeyPatch) -> FulfillerHub:
    h = FulfillerHub()
    monkeypatch.setattr(
        "agentcore.fulfill.dispatch.default_fulfiller_hub", lambda: h, raising=True
    )
    return h


@pytest.fixture
def session(hub: FulfillerHub) -> FulfillerSession:
    return hub.register(USER, "dev-1", caps=FULFILL_CHANNELS, roots=())


@pytest.fixture
def registry() -> Iterator[InteractionRegistry]:
    """The process-wide registry (``cancel_pending_client_tools`` reads it)."""
    reg = default_interaction_registry()
    before = {r.id for r in reg.list_pending()}
    yield reg
    for req in list(reg.list_pending()):
        if req.id not in before:
            req.future.cancel()
            reg.discard(req.id)


def _pending_host_op(registry: InteractionRegistry, request_id: str) -> None:
    registry.create(
        request_id,
        CID,
        kind=InteractionKind.CLIENT_TOOL,
        payload=client_tool_payload(
            CHANNEL_HOST,
            EventType.HOST_OP_REQUIRED.value,
            params={"op": "host_shell", "args": {"command": "sleep 300"}},
            user_id=USER,
        ),
    )


async def test_pushes_a_cancel_frame_per_in_flight_op(
    registry: InteractionRegistry, session: FulfillerSession
) -> None:
    _pending_host_op(registry, "r-1")

    assert cancel_pending_client_tools(CID) == 1

    frame = await asyncio.wait_for(session.get(), 1)
    assert frame == {
        "type": "client_tool_cancelled",
        "payload": {"request_id": "r-1", "conversation_id": CID},
    }


async def test_skips_other_conversations_and_settled_ops(
    registry: InteractionRegistry, session: FulfillerSession
) -> None:
    _pending_host_op(registry, "r-mine")
    other = registry.create(
        "r-other",
        "c-other",
        kind=InteractionKind.CLIENT_TOOL,
        payload=client_tool_payload(
            CHANNEL_HOST,
            EventType.HOST_OP_REQUIRED.value,
            params={"op": "host_shell", "args": {}},
            user_id=USER,
        ),
    )
    settled = registry.create(
        "r-settled",
        CID,
        kind=InteractionKind.CLIENT_TOOL,
        payload=client_tool_payload(
            CHANNEL_HOST,
            EventType.HOST_OP_REQUIRED.value,
            params={"op": "host_shell", "args": {}},
            user_id=USER,
        ),
    )
    settled.set_result({"ok": True})

    assert cancel_pending_client_tools(CID) == 1
    frame = await asyncio.wait_for(session.get(), 1)
    assert frame["payload"]["request_id"] == "r-mine"
    assert not other.done()


async def test_non_client_tool_pending_is_left_alone(
    registry: InteractionRegistry, session: FulfillerSession
) -> None:
    approval = registry.create(
        "r-approval", CID, kind=InteractionKind.APPROVAL, payload={"user_id": USER}
    )

    assert cancel_pending_client_tools(CID) == 0
    assert not approval.done()


async def test_offline_device_is_a_no_op(registry: InteractionRegistry, hub: FulfillerHub) -> None:
    """Best-effort: nobody online ⇒ nothing to tell (and no exception)."""
    _pending_host_op(registry, "r-offline")

    assert cancel_pending_client_tools(CID) == 0
