"""CLIENT_TOOL ``*_required`` frames: registry payload + fulfill-side re-hang.

``*_op_required`` / notify / board_read stay EPHEMERAL (not journaled). Delivery
goes through the device-level fulfill hub (:func:`push_client_tool_required`),
not the turn display EventSink. On fulfiller connect / reconnect / roots update,
:func:`rehang_pending_client_tools` re-pushes still-open registry entries so an
in-flight op is not lost when the desktop briefly drops. Done / cancelled /
discarded entries are absent from ``list_pending`` and are not re-sent.
Process restart does not promise reattach. Both re-hang and cancel run outside
the turn's context, so the payload carries the origin device (:func:`client_tool_payload`)
and they route by that copy — never by whichever device happens to be online.

The reverse direction is :func:`cancel_pending_client_tools`: an explicit user
stop drops the awaiter, so the device must be told to abort the op it is still
running (otherwise a dispatched ``host_shell`` finishes on the user's machine
long after the turn is gone).
"""

from __future__ import annotations

from typing import Any, NamedTuple

from agentcore.core.logging import get_logger
from agentcore.fulfill.origin import current_origin_device
from agentcore.runtime.events.board import board_op_required, board_read_required
from agentcore.runtime.events.desktop import (
    desktop_notify_required,
    external_mount_readonly_required,
    host_op_required,
    mcp_op_required,
)
from agentcore.runtime.events.types import SSEEvent
from agentcore.runtime.events.workspace import workspace_op_required
from agentcore.runtime.interaction import InteractionKind, InteractionRequest
from agentcore.runtime.ports import ClientRequestBridge

logger = get_logger(__name__)

# Stable channel tags written into ``InteractionRequest.payload`` at suspend.
CHANNEL_HOST = "host"
CHANNEL_MCP = "mcp"
CHANNEL_WORKSPACE = "workspace"
CHANNEL_BOARD = "board"
CHANNEL_BOARD_READ = "board_read"
CHANNEL_NOTIFY = "notify"
CHANNEL_EXTERNAL_MOUNT = "external_mount"

# Meta keys on the registry payload (not forwarded into the SSE wire body).
_META_KEYS = frozenset({"channel", "event_type", "user_id", "origin_device_id"})


def client_tool_payload(
    channel: str,
    event_type: str,
    *,
    params: dict[str, Any],
    user_id: str | None = None,
) -> dict[str, Any]:
    """Registry payload: stable channel/event_type + original op params (+ user).

    Also snapshots the turn's origin device (``fulfill/origin.py``) beside the
    rest of the routing meta. Re-hang and cancel run after the turn context is
    gone — without the snapshot they would re-route a pinned op to whichever
    device reconnected, which is precisely what the pin forbids.
    """
    out: dict[str, Any] = {"channel": channel, "event_type": event_type, **params}
    if user_id:
        out["user_id"] = user_id
    origin_device_id = current_origin_device()
    if origin_device_id:
        out["origin_device_id"] = origin_device_id
    return out


def build_client_tool_required(req: InteractionRequest) -> SSEEvent | None:
    """Rebuild the EPHEMERAL ``*_required`` SSE for one open CLIENT_TOOL request."""
    if req.kind != InteractionKind.CLIENT_TOOL:
        return None
    if req.future.done():
        return None
    channel = req.payload.get("channel")
    if not isinstance(channel, str) or not channel:
        # Prefer explicit event_type when channel is missing (older in-flight entries).
        channel = _channel_from_event_type(req.payload.get("event_type"))
    if channel is None:
        return None

    params = {k: v for k, v in req.payload.items() if k not in _META_KEYS}
    rid = req.id
    cid = req.conversation_id

    if channel == CHANNEL_WORKSPACE:
        raw_timeout = params.get("timeout_ms")
        timeout_ms: int | None = None
        if isinstance(raw_timeout, int) and raw_timeout > 0:
            timeout_ms = raw_timeout
        elif isinstance(raw_timeout, float) and raw_timeout > 0:
            timeout_ms = int(raw_timeout)
        return workspace_op_required(
            request_id=rid,
            conversation_id=cid,
            root_id=str(params.get("root_id") or ""),
            op=str(params.get("op") or ""),
            args=dict(params.get("args") or {}),
            timeout_ms=timeout_ms,
        )
    if channel == CHANNEL_BOARD:
        ops = params.get("ops")
        return board_op_required(
            request_id=rid,
            conversation_id=cid,
            board_id=str(params.get("board_id") or ""),
            ops=list(ops) if isinstance(ops, list) else [],
            summary=str(params.get("summary") or ""),
        )
    if channel == CHANNEL_BOARD_READ:
        ids = params.get("ids")
        return board_read_required(
            request_id=rid,
            conversation_id=cid,
            board_id=str(params.get("board_id") or ""),
            ids=list(ids) if isinstance(ids, list) else [],
        )
    if channel == CHANNEL_HOST:
        return host_op_required(
            request_id=rid,
            conversation_id=cid,
            op=str(params.get("op") or ""),
            args=dict(params.get("args") or {}),
        )
    if channel == CHANNEL_MCP:
        return mcp_op_required(
            request_id=rid,
            conversation_id=cid,
            op=str(params.get("op") or ""),
            args=dict(params.get("args") or {}),
        )
    if channel == CHANNEL_NOTIFY:
        return desktop_notify_required(
            request_id=rid,
            conversation_id=cid,
            title=str(params.get("title") or ""),
            body=str(params.get("body") or ""),
        )
    if channel == CHANNEL_EXTERNAL_MOUNT:
        path = params.get("path")
        well_known = params.get("well_known")
        target_name = params.get("target_name")
        return external_mount_readonly_required(
            request_id=rid,
            conversation_id=cid,
            path=str(path) if isinstance(path, str) and path.strip() else None,
            well_known=(
                str(well_known)
                if isinstance(well_known, str) and well_known.strip()
                else None
            ),
            target_name=(
                str(target_name)
                if isinstance(target_name, str) and target_name.strip()
                else None
            ),
        )
    return None


def push_client_tool_required(
    *,
    user_id: str,
    conversation_id: str,
    channel: str,
    root_id: str | None,
    event: SSEEvent,
    registry: ClientRequestBridge,
    request_id: str,
    error_kind: str,
    error_detail: str,
    origin_offline_detail: str | None = None,
    root_not_held_detail: str | None = None,
) -> bool:
    """Deliver via the fulfill hub; when nobody can run it, settle the op now.

    Returns ``True`` when a fulfiller received the frame. ``False`` means the
    registry Future was settled with a typed failure envelope (caller awaits it).

    ``origin_offline_detail`` is the copy for a pinned channel whose origin
    device left while other devices stayed online — telling the user their
    desktop is disconnected would be wrong, since one of them still is.
    ``root_not_held_detail`` is the same kind of correction for a rooted op the
    online desktop no longer declares: the machine is there, the folder grant is
    not, and only the user can put it back. Callers that leave either unset fall
    back to ``error_detail``.
    """
    from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool

    status = deliver_client_tool(
        user_id,
        conversation_id,
        channel,
        root_id,
        event,
        origin_device_id=current_origin_device(),
    )
    if status is DeliverResult.DELIVERED:
        return True
    detail = error_detail
    if status is DeliverResult.ORIGIN_OFFLINE and origin_offline_detail:
        detail = origin_offline_detail
    elif status is DeliverResult.ROOT_NOT_HELD and root_not_held_detail:
        detail = root_not_held_detail
    registry.resolve(
        request_id,
        {
            "ok": False,
            "error": {"kind": error_kind, "detail": detail},
        },
        conversation_id=conversation_id,
    )
    return False


class _PendingRoute(NamedTuple):
    """Where one still-open CLIENT_TOOL request has to be delivered."""

    user_id: str
    channel: str
    root_id: str | None
    origin_device_id: str | None


def _pending_client_tool_route(req: InteractionRequest) -> _PendingRoute | None:
    """Delivery route for an open CLIENT_TOOL request, else ``None``."""
    if req.kind != InteractionKind.CLIENT_TOOL or req.future.done():
        return None
    user_id = req.payload.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        return None
    channel = req.payload.get("channel")
    if not isinstance(channel, str) or not channel:
        channel = _channel_from_event_type(req.payload.get("event_type"))
    if not channel:
        return None
    raw_root = req.payload.get("root_id")
    root_id = raw_root.strip() if isinstance(raw_root, str) else None
    raw_origin = req.payload.get("origin_device_id")
    origin = raw_origin.strip() if isinstance(raw_origin, str) else None
    return _PendingRoute(user_id, channel, (root_id or None), (origin or None))


def client_tool_cancelled_frame(*, request_id: str, conversation_id: str) -> dict[str, Any]:
    """The fulfill-channel frame that tells a device to abort one in-flight op.

    Deliberately **not** an ``SSEEvent``: it never rides the conversation display
    stream (no journal, no fold) — only the device fulfill channel, whose wire
    body is ``{type, payload}`` (see ``fulfill.dispatch``).
    """
    return {
        "type": "client_tool_cancelled",
        "payload": {"request_id": request_id, "conversation_id": conversation_id},
    }


def cancel_pending_client_tools(conversation_id: str) -> int:
    """Abort this conversation's in-flight CLIENT_TOOL ops on their fulfiller.

    Call BEFORE cancelling the turn task: once the awaiting task unwinds,
    ``InteractionRegistry.suspend``'s ``finally`` discards the entries and there is
    nothing left to address, so the device would keep running an op nobody awaits.
    Best-effort — a device that is offline simply never hears about it (nor is the
    abort re-routed: only the machine actually running the op can stop it).
    Returns how many cancel frames were enqueued.
    """
    from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool
    from agentcore.runtime.interaction import default_interaction_registry

    cancelled = 0
    for req in default_interaction_registry().list_pending(conversation_id):
        route = _pending_client_tool_route(req)
        if route is None:
            continue
        status = deliver_client_tool(
            route.user_id,
            conversation_id,
            route.channel,
            route.root_id,
            client_tool_cancelled_frame(
                request_id=req.id, conversation_id=conversation_id
            ),
            origin_device_id=route.origin_device_id,
        )
        if status is DeliverResult.DELIVERED:
            cancelled += 1
    if cancelled:
        logger.info(
            "client_tool.cancel_pushed",
            conversation_id=conversation_id,
            count=cancelled,
        )
    return cancelled


def pending_client_tool_events(conversation_id: str) -> list[SSEEvent]:
    """Open CLIENT_TOOL ``*_required`` frames for one conversation (rebuild only).

    Prefer :func:`rehang_pending_client_tools` on fulfiller connect — display-stream
    attach no longer re-hangs CLIENT_TOOL.
    """
    from agentcore.runtime.interaction import default_interaction_registry

    out: list[SSEEvent] = []
    for req in default_interaction_registry().list_pending(conversation_id):
        event = build_client_tool_required(req)
        if event is not None:
            out.append(event)
    return out


def rehang_pending_client_tools(user_id: str) -> int:
    """Re-deliver this user's open CLIENT_TOOL frames to a live fulfiller.

    Called when a fulfiller connects / reconnects or updates roots. Does **not**
    settle on ``NO_FULFILLER`` — the Future stays open until a capable device
    appears, the channel times out, or the op is discarded. A pinned op re-hangs
    only onto the device that originally asked for it: another install coming
    online is not an invitation to run someone else's shell command. Returns how
    many frames were successfully enqueued.
    """
    from agentcore.fulfill.dispatch import DeliverResult, deliver_client_tool
    from agentcore.runtime.interaction import default_interaction_registry

    delivered = 0
    for req in default_interaction_registry().list_pending():
        route = _pending_client_tool_route(req)
        if route is None or route.user_id != user_id:
            continue
        event = build_client_tool_required(req)
        if event is None:
            continue
        status = deliver_client_tool(
            user_id,
            req.conversation_id,
            route.channel,
            route.root_id,
            event,
            origin_device_id=route.origin_device_id,
        )
        if status is DeliverResult.DELIVERED:
            delivered += 1
    if delivered:
        logger.info(
            "client_tool.rehang",
            user=user_id,
            delivered=delivered,
        )
    return delivered


def _channel_from_event_type(event_type: Any) -> str | None:
    if not isinstance(event_type, str):
        return None
    return {
        "workspace_op_required": CHANNEL_WORKSPACE,
        "board_op_required": CHANNEL_BOARD,
        "board_read_required": CHANNEL_BOARD_READ,
        "host_op_required": CHANNEL_HOST,
        "mcp_op_required": CHANNEL_MCP,
        "desktop_notify_required": CHANNEL_NOTIFY,
        "external_mount_readonly_required": CHANNEL_EXTERNAL_MOUNT,
    }.get(event_type)
