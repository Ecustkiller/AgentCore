"""Desktop Client Tools SSE event factories."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.types import EventType, SSEEvent


def desktop_notify_required(
    *,
    request_id: str,
    conversation_id: str,
    title: str,
    body: str = "",
) -> SSEEvent:
    """Ask the bound desktop to show an OS notification (transport-only client_tool)."""
    return SSEEvent(
        type=EventType.DESKTOP_NOTIFY_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "title": title,
            "body": body,
        },
    )


def external_mount_readonly_required(
    *,
    request_id: str,
    conversation_id: str,
    path: str | None = None,
    well_known: str | None = None,
    target_name: str | None = None,
) -> SSEEvent:
    """Ask the bound desktop to silently mount a local directory read-only.

    Path transport exception (C1): may carry ``path`` and/or ``well_known``+
    ``target_name`` for desktop resolve. Success settle must not include abs.
    """
    payload: dict[str, Any] = {
        "request_id": request_id,
        "conversation_id": conversation_id,
    }
    if path:
        payload["path"] = path
    if well_known:
        payload["well_known"] = well_known
    if target_name:
        payload["target_name"] = target_name
    return SSEEvent(
        type=EventType.EXTERNAL_MOUNT_READONLY_REQUIRED,
        payload=payload,
    )


def host_op_required(
    *,
    request_id: str,
    conversation_id: str,
    op: str,
    args: dict[str, Any] | None = None,
) -> SSEEvent:
    """Ask the bound desktop to run a Host op and report back (transport-only)."""
    return SSEEvent(
        type=EventType.HOST_OP_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "op": op,
            "args": args or {},
        },
    )


def mcp_op_required(
    *,
    request_id: str,
    conversation_id: str,
    op: str,
    args: dict[str, Any] | None = None,
) -> SSEEvent:
    """Ask the bound desktop to run an MCP Client op (list/call) and report back."""
    return SSEEvent(
        type=EventType.MCP_OP_REQUIRED,
        payload={
            "request_id": request_id,
            "conversation_id": conversation_id,
            "op": op,
            "args": args or {},
        },
    )
