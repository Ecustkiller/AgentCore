"""Shared helpers: drive CLIENT_TOOL channels via fulfill dispatch capture.

The capture itself is installed for EVERY test by the autouse
``_capture_client_tool_deliveries`` fixture in ``tests/conftest.py`` — test modules only
import the read side (:func:`await_captured_event` / :data:`DELIVERED_EVENTS`).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agentcore.fulfill.dispatch import DeliverResult
from agentcore.fulfill.hub import FULFILL_CHANNELS, FulfillerHub, FulfillerSession
from agentcore.runtime.events.types import SSEEvent

# Module-level capture filled by ``install_deliver_capture`` (SSEEvent instances).
DELIVERED_EVENTS: list[SSEEvent] = []


def install_deliver_capture(monkeypatch: pytest.MonkeyPatch) -> list[SSEEvent]:
    """Patch fulfill dispatch to succeed and append SSEEvents for test awaits."""
    DELIVERED_EVENTS.clear()

    def fake_deliver(
        user_id,
        conversation_id,
        channel,
        root_id,
        event,
        *,
        origin_device_id=None,
        hub=None,
    ):
        DELIVERED_EVENTS.append(event)
        return DeliverResult.DELIVERED

    monkeypatch.setattr(
        "agentcore.fulfill.dispatch.deliver_client_tool", fake_deliver
    )
    return DELIVERED_EVENTS


async def await_captured_event(
    capture: list[SSEEvent] | None = None,
    *,
    timeout_spins: int = 2000,
) -> SSEEvent:
    buf = DELIVERED_EVENTS if capture is None else capture
    for _ in range(timeout_spins):
        if buf:
            return buf.pop(0)
        await asyncio.sleep(0)
    raise AssertionError("no CLIENT_TOOL event delivered")


def install_test_hub(
    monkeypatch: Any,
    *,
    user_id: str,
    device_id: str = "test-device",
    roots: set[str] | frozenset[str] | list[str] | None = None,
    caps: frozenset[str] | set[str] | None = None,
) -> tuple[FulfillerHub, FulfillerSession]:
    """Replace the process hub with a fresh one and register one fulfiller."""
    hub = FulfillerHub()
    session = hub.register(
        user_id,
        device_id,
        caps=caps if caps is not None else FULFILL_CHANNELS,
        roots=roots or (),
    )
    monkeypatch.setattr(
        "agentcore.fulfill.dispatch.default_fulfiller_hub",
        lambda: hub,
    )
    monkeypatch.setattr(
        "agentcore.fulfill.hub.default_fulfiller_hub",
        lambda: hub,
    )
    return hub, session


async def await_fulfill_event(
    session: FulfillerSession,
    *,
    timeout: float = 1.0,
) -> dict[str, Any]:
    """Wait for the next fulfill-wire frame (dict with type/payload)."""
    event = await asyncio.wait_for(session.get(), timeout=timeout)
    if event is None:
        raise AssertionError("fulfiller session closed before op delivered")
    return event
