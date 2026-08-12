"""Device-level CLIENT_TOOL fulfillment SSE (本机工作区履约通道).

Each online desktop (or other capable client) holds one long-lived
``GET /v1/fulfill`` subscription declaring ``device_id``, channel ``caps``, and
the ``roots`` it currently holds. The server routes ``*_required`` frames to the
matching device instead of the turn display sink — so a healthy desktop that is
not watching the conversation can still fulfil local ops.

Auth is the access-token cookie (same as ``/v1/realtime``). SSE cannot refresh a
token mid-stream; on 401 the client reconnects after refresh. Root set changes
use ``POST /v1/fulfill/roots`` without tearing down the stream.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.responses import StreamingResponse

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.api.schemas import StatusResponse, UpdateFulfillRootsRequest
from agentcore.api.sse import release_request_db_before_sse
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.core.logging import get_logger
from agentcore.fulfill.hub import (
    FULFILL_CHANNELS,
    FulfillerHub,
    FulfillerSession,
    default_fulfiller_hub,
)

logger = get_logger(__name__)

router = APIRouter(prefix="/fulfill", tags=["fulfill"])

# Idle gap after which a heartbeat comment is sent (keep proxies / NAT warm).
_HEARTBEAT_SECONDS = 25.0


def _parse_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [part.strip() for part in raw.split(",") if part.strip()]


def _parse_caps(raw: str | None) -> frozenset[str]:
    parts = _parse_csv(raw)
    unknown = sorted({p for p in parts if p not in FULFILL_CHANNELS})
    if unknown:
        raise ValidationError(f"unknown fulfill caps: {', '.join(unknown)}")
    return frozenset(parts)


def _format_event(event: dict) -> str:
    """Serialize a hub event dict as one ``text/event-stream`` frame."""
    event_type = str(event.get("type", "message"))
    data = json.dumps(event, ensure_ascii=False)
    return f"event: {event_type}\ndata: {data}\n\n"


async def _fulfill_stream(
    session: FulfillerSession,
    hub: FulfillerHub,
) -> AsyncIterator[str]:
    """Yield SSE frames for ``session`` until the client disconnects.

    Mirrors ``realtime._firehose``: persistent ``get`` across heartbeat windows
    (never cancelled on a mere timeout); ``ready`` inside ``try`` so disconnect
    still runs unregister.
    """
    get_task: asyncio.Task[dict | None] | None = None
    try:
        yield _format_event({"type": "ready"})
        while True:
            if get_task is None:
                get_task = asyncio.ensure_future(session.get())
            done, _ = await asyncio.wait({get_task}, timeout=_HEARTBEAT_SECONDS)
            if not done:
                yield ": keep-alive\n\n"
                continue
            event = get_task.result()
            get_task = None
            if event is None:
                return
            yield _format_event(event)
    finally:
        if get_task is not None:
            get_task.cancel()
        hub.unregister(session)


@router.get("")
async def fulfill_stream(
    user: AuthUser,
    device_id: Annotated[str, Query(min_length=1, max_length=128)],
    session: AsyncSession = Depends(get_db),
    caps: Annotated[str, Query()] = "",
    roots: Annotated[str, Query()] = "",
    x_client_platform: Annotated[str | None, Header(alias="X-Client-Platform")] = None,
) -> StreamingResponse:
    """Open this device's fulfillment channel (server→client SSE).

    Query params: ``device_id`` (required), ``caps`` (comma-separated channel
    names), ``roots`` (comma-separated root ids, may be empty). Platform comes
    from ``X-Client-Platform``.
    """
    await release_request_db_before_sse(session)

    cap_set = _parse_caps(caps)
    root_list = _parse_csv(roots)
    hub = default_fulfiller_hub()
    fulfiller = hub.register(
        user.user_id,
        device_id,
        caps=cap_set,
        roots=root_list,
        platform=x_client_platform,
    )
    # Re-push in-flight CLIENT_TOOL frames so a reconnect does not drop ops that
    # were delivered to the previous session (registry Futures stay open).
    from agentcore.runtime.events.client_tool_reattach import rehang_pending_client_tools

    rehang_pending_client_tools(user.user_id)

    return StreamingResponse(
        _fulfill_stream(fulfiller, hub),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/roots", response_model=StatusResponse)
async def update_fulfill_roots(
    body: UpdateFulfillRootsRequest,
    user: AuthUser,
) -> StatusResponse:
    """Update the root set declared by an online fulfiller without reconnecting."""
    hub = default_fulfiller_hub()
    if not hub.update_roots(user.user_id, body.device_id, body.roots):
        raise NotFoundError("履约会话不在线")
    # Newly declared roots may unblock pending workspace ops — re-push now.
    from agentcore.runtime.events.client_tool_reattach import rehang_pending_client_tools

    rehang_pending_client_tools(user.user_id)
    return StatusResponse()
