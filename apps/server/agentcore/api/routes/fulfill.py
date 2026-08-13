"""Device-level CLIENT_TOOL fulfillment SSE (本机工作区履约通道).

Each online desktop (or other capable client) holds one long-lived
``GET /v1/fulfill`` subscription declaring ``device_id``, channel ``caps``, and
the permanent ``roots`` it currently holds. The server routes ``*_required``
frames to the matching device instead of the turn display sink — so a healthy
desktop that is not watching the conversation can still fulfil local ops.

Conversation-scoped grants are **not** in that query param. They are bound to
this device when the desktop registers them (``fulfill/declare.py``) and are
re-seeded here from storage, because a reconnect builds a brand-new session:
the client pushing its whole grant set back was a second source of truth for a
fact the server already owns, and the window before it landed was where a
mount's first op met an empty hub.

Auth is the access-token cookie (same as ``/v1/realtime``). SSE cannot refresh a
token mid-stream; on 401 the client reconnects after refresh.
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
from agentcore.api.sse import release_request_db_before_sse
from agentcore.core.errors import ValidationError
from agentcore.core.logging import get_logger
from agentcore.db.repositories.external_grants import ExternalGrantRepository
from agentcore.fulfill.hub import (
    FULFILL_CHANNELS,
    FulfillerHub,
    FulfillerSession,
    default_fulfiller_hub,
)
from agentcore.runtime.turn.queue import turn_queue

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


async def _bound_grant_roots(
    session: AsyncSession, user_id: str, device_id: str
) -> list[str]:
    """External-grant roots this device registered, read back on (re)connect.

    The binding lives in the grant row; the session holding it does not survive
    a reconnect. Read before ``release_request_db_before_sse`` — the request's
    DB session is returned to the pool before the stream body starts.
    """
    roots = await ExternalGrantRepository(session).list_root_ids_for_device(
        user_id=user_id, device_id=device_id
    )
    if roots:
        logger.info(
            "fulfill.grant_roots_seeded",
            user=user_id,
            device=device_id,
            roots=len(roots),
        )
    return roots


def _format_event(event: dict) -> str:
    """Serialize a hub event dict as one ``text/event-stream`` frame."""
    event_type = str(event.get("type", "message"))
    data = json.dumps(event, ensure_ascii=False)
    return f"event: {event_type}\ndata: {data}\n\n"


def _seed_registered_session(session: FulfillerSession, hub: FulfillerHub) -> None:
    """Replay in-flight ops onto a capable fulfiller; always seed account state.

    A reconnect must re-push CLIENT_TOOL frames the previous session already
    saw (registry Futures stay open). Observers — web tabs, zero caps,
    :attr:`FulfillerSession.can_fulfil` is false — share this stream for the
    same account snapshots, but must not rehang: that would re-deliver
    ``workspace_op`` / ``host_op`` onto the live desktop and run the side
    effect twice. Do not paper over that with request_id dedup on the
    desktop (a reconnect that dropped the first frame would swallow it).
    """
    from agentcore.runtime.events.client_tool_reattach import rehang_pending_client_tools

    if session.can_fulfil:
        rehang_pending_client_tools(session.user_id)
    for frame in turn_queue.snapshot_frames(session.user_id):
        hub.deliver(session, frame)


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
    names), ``roots`` (the device's permanent authorized roots, may be empty).
    Platform comes from ``X-Client-Platform``. Conversation grants bound to this
    device are added from storage — the client does not re-declare them.
    """
    cap_set = _parse_caps(caps)
    root_list = _parse_csv(roots)
    root_list.extend(await _bound_grant_roots(session, user.user_id, device_id))
    await release_request_db_before_sse(session)

    hub = default_fulfiller_hub()
    fulfiller = hub.register(
        user.user_id,
        device_id,
        caps=cap_set,
        roots=root_list,
        platform=x_client_platform,
    )
    _seed_registered_session(fulfiller, hub)

    return StreamingResponse(
        _fulfill_stream(fulfiller, hub),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

