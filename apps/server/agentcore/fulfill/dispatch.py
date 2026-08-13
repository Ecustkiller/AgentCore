"""Fulfillment delivery seam — select a live device and push a CLIENT_TOOL frame.

Callers (workspace / host / mcp / board / … channels) use
:func:`deliver_client_tool` instead of emitting into the turn display EventSink.
This module only routes + delivers; timeouts and retries stay with the channel.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.fulfill.hub import FulfillerHub, default_fulfiller_hub, origin_pinned
from agentcore.runtime.events.types import SSEEvent

logger = get_logger(__name__)


class DeliverResult(StrEnum):
    """Outcome of a one-shot fulfillment delivery attempt."""

    DELIVERED = "delivered"
    NO_FULFILLER = "no_fulfiller"
    # Pinned channel, origin device gone, other capable devices online. Kept
    # apart from NO_FULFILLER so callers can say *why* nothing ran instead of
    # implying the user has no desktop connected at all.
    ORIGIN_OFFLINE = "origin_offline"
    # A device is online with this channel's cap, but none declares ``root_id``
    # (authorization removed, or the user moved machines). Same fact the
    # turn-start presence gate names ``root_not_held``; delivery meets it again
    # mid-turn because the gate runs once and roots change afterwards.
    ROOT_NOT_HELD = "root_not_held"


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
    origin_device_id: str | None = None,
    hub: FulfillerHub | None = None,
) -> DeliverResult:
    """Select a fulfiller and enqueue ``event``. No timeout / retry.

    ``origin_device_id`` is the device that started this turn: preferred
    everywhere, and on a pinned channel (``hub.origin_pinned``) required — those
    ops run against one specific machine, so a missing origin returns
    :attr:`DeliverResult.ORIGIN_OFFLINE` rather than picking a peer.

    A selection miss is split the same three ways the turn-start presence gate
    splits it (``runtime/pipeline/errors.py``): :attr:`DeliverResult.ORIGIN_OFFLINE`,
    :attr:`DeliverResult.ROOT_NOT_HELD` when a capable device is online without
    this root, else :attr:`DeliverResult.NO_FULFILLER`. Root matching itself is
    untouched — ``root_id`` is an authorization boundary, so a device that never
    declared it stays ineligible; only the answer the user reads gets sharper.

    If an unpinned delivery's session has a full queue it is closed as unhealthy
    and selection retries against the remaining devices; a pinned delivery does
    not retry, because "try the next machine" is exactly what the pin exists to
    prevent.
    """
    target = hub if hub is not None else default_fulfiller_hub()
    wire = _event_to_wire(event)
    pinned = bool(origin_device_id) and origin_pinned(channel, root_id=root_id)

    while True:
        session = target.find(
            user_id,
            root_id=root_id,
            channel=channel,
            origin_device_id=origin_device_id,
            require_origin=pinned,
        )
        if session is None:
            # Only claim "origin offline" when a peer could in fact have taken
            # it — a single-device user gets the unchanged no-fulfiller copy.
            if pinned and target.has_fulfiller(
                user_id, root_id=root_id, channel=channel
            ):
                return _origin_offline(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    channel=channel,
                    root_id=root_id,
                    origin_device_id=origin_device_id,
                    reason="not_online",
                )
            # Which of the gate's cases this miss is, recorded so a post-hoc log
            # read can tell "desktop gone" from "desktop here, root revoked"
            # (the third case has its own ``fulfill.origin_offline`` line).
            root_not_held = bool(root_id) and target.has_fulfiller(
                user_id, root_id=None, channel=channel
            )
            logger.info(
                "fulfill.no_fulfiller",
                user=user_id,
                conversation_id=conversation_id,
                channel=channel,
                root_id=root_id,
                origin_device=origin_device_id,
                reason="root_not_held" if root_not_held else "desktop_offline",
                devices=target.connection_count(user_id),
            )
            if root_not_held:
                return DeliverResult.ROOT_NOT_HELD
            return DeliverResult.NO_FULFILLER
        if target.deliver(session, wire):
            logger.info(
                "fulfill.delivered",
                user=user_id,
                conversation_id=conversation_id,
                channel=channel,
                root_id=root_id,
                device=session.device_id,
                origin_device=origin_device_id,
                type=wire.get("type"),
            )
            return DeliverResult.DELIVERED
        if pinned:
            # deliver() just closed the origin session as unhealthy; the retry
            # below would hand a disk / command op to another machine.
            return _origin_offline(
                user_id=user_id,
                conversation_id=conversation_id,
                channel=channel,
                root_id=root_id,
                origin_device_id=origin_device_id,
                reason="queue_full",
            )
        # Session was closed as unhealthy; loop to try another candidate.


def _origin_offline(
    *,
    user_id: str,
    conversation_id: str,
    channel: str,
    root_id: str | None,
    origin_device_id: str | None,
    reason: str,
) -> DeliverResult:
    """Log why the pinned device could not take the op and refuse to reroute."""
    logger.info(
        "fulfill.origin_offline",
        user=user_id,
        conversation_id=conversation_id,
        channel=channel,
        root_id=root_id,
        origin_device=origin_device_id,
        reason=reason,
    )
    return DeliverResult.ORIGIN_OFFLINE
