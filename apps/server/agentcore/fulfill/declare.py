"""Registration receipts *are* the device's root declaration (登记即声明).

A root id is minted on one desktop and registered with the server in the same
breath — an external directory grant, a workspace bind. Before this, the server
learned the id from that registration and learned *which machine holds it* from
a separate ``GET /v1/fulfill`` declaration: two channels with no ordering
between them. The gap was not a rare race but the whole story behind「首个 op 撞
no fulfiller」— the turn resumes on the receipt and dispatches immediately,
while the declaration is still in flight.

So the receipt binds it. The registering request already carries the caller's
durable ``device_id`` (``X-Client-Device``, bound onto the request task by
:class:`~agentcore.middleware.origin_device.OriginDeviceMiddleware`) and it is
the same id that device's fulfill session registers under. Returning 201 then
means「服务端已知这台设备能履约这个根」with nothing left to land.

Requests without a device — mobile, web, server-side callers — declare nothing.
They are not fulfillers, and inventing a binding for them would aim a local op
at a machine that never claimed the folder.
"""

from __future__ import annotations

from agentcore.core.logging import get_logger
from agentcore.fulfill.hub import default_fulfiller_hub
from agentcore.fulfill.origin import current_origin_device

logger = get_logger(__name__)


def declare_receipt_root(user_id: str, root_id: str) -> str | None:
    """Bind ``root_id`` to the requesting device's fulfill session.

    Returns the device id the caller declared (``None`` when it declared none),
    so the caller can persist the binding alongside the registration — the live
    session is replaced on every reconnect, and only a stored binding survives
    that. An offline device still returns its id for the same reason.

    Newly bound roots can un-park an op held by the reconnect grace, so a
    successful declaration re-pushes this user's open CLIENT_TOOL frames.
    """
    device_id = (current_origin_device() or "").strip()
    rid = (root_id or "").strip()
    if not device_id or not rid or not user_id:
        return None
    if default_fulfiller_hub().declare_root(user_id, device_id, rid):
        from agentcore.runtime.events.client_tool_reattach import (
            rehang_pending_client_tools,
        )

        rehang_pending_client_tools(user_id)
    else:
        logger.info(
            "fulfill.receipt_device_offline",
            user=user_id,
            device=device_id,
            root_id=rid,
        )
    return device_id
