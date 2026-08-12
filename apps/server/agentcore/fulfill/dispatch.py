"""Fulfillment delivery seam — select a live device and push a CLIENT_TOOL frame.

Callers (workspace / host / mcp / board / … channels) use
:func:`deliver_client_tool` instead of emitting into the turn display EventSink.
This module only routes + delivers; timeouts and retries stay with the channel.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.fulfill.hub import FulfillerHub, default_fulfiller_hub
from agentcore.runtime.events.types import SSEEvent

logger = get_logger(__name__)


class DeliverResult(StrEnum):
    """Outcome of a one-shot fulfillment delivery attempt."""

    DELIVERED = "delivered"
    NO_FULFILLER = "no_fulfiller"


def _event_to_wire(event: SSEEvent | dict[str, Any]) -> dict[str, Any]:
    """Normalize an ``SSEEvent`` or already-wire dict into the fulfill SSE body."""
    if isinstance(event, SSEEvent):
        event_type = event.type.value if hasattr(event.type, "value") else str(event.type)
        return {
            "type": event_type,
            "timestamp": event.timestamp,
            "payload": dict(event.payload),
        }
    return dict(event)


def deliver_client_tool(
    user_id: str,
    conversation_id: str,
    channel: str,
    root_id: str | None,
    event: SSEEvent | dict[str, Any],
    *,
    hub: FulfillerHub | None = None,
) -> DeliverResult:
    """Select a fulfiller and enqueue ``event``. No timeout / retry.

    Returns :attr:`DeliverResult.NO_FULFILLER` when no online device matches
    ``channel`` (+ ``root_id``). If the chosen session's queue is full it is
    closed as unhealthy and selection retries against remaining devices.
    """
    target = hub if hub is not None else default_fulfiller_hub()
    wire = _event_to_wire(event)

    # Retry after queue-full closes so a stuck device does not block a healthy peer.
    while True:
        session = target.find(user_id, root_id=root_id, channel=channel)
        if session is None:
            logger.info(
                "fulfill.no_fulfiller",
                user=user_id,
                conversation_id=conversation_id,
                channel=channel,
                root_id=root_id,
            )
            return DeliverResult.NO_FULFILLER
        if target.deliver(session, wire):
            logger.info(
                "fulfill.delivered",
                user=user_id,
                conversation_id=conversation_id,
                channel=channel,
                root_id=root_id,
                device=session.device_id,
                type=wire.get("type"),
            )
            return DeliverResult.DELIVERED
        # Session was closed as unhealthy; loop to try another candidate.
