"""Bind the requesting device so CLIENT_TOOL ops land on the machine that asked.

Desktop installs send ``X-Client-Device`` (their durable fulfill ``device_id``)
alongside ``X-Client-Platform``. Binding it once per request means every turn
task the handler spawns inherits it, and the fulfill hub can pin disk / command
/ mount ops to that install instead of picking the most recently registered one
(see ``fulfill/origin.py``).

Pure ASGI (not BaseHTTPMiddleware) so the binding sits on the same task as the
route handler — the task whose context ``asyncio.create_task`` copies into the
turn. Mobile / web send no such header and stay unbound (they are not
fulfillers), which keeps selection at its pre-multi-device behavior.
"""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

from agentcore.fulfill.origin import bind_origin_device, reset_origin_device

_DEVICE_HEADER = b"x-client-device"

# Long enough for the desktop's uuid4 hex; matches the ``device_id`` query param
# bound on ``GET /v1/fulfill`` so a value that could never register is dropped.
_MAX_DEVICE_ID_LEN = 128


def _device_id_from_scope(scope: Scope) -> str | None:
    for name, value in scope.get("headers") or ():
        if name != _DEVICE_HEADER:
            continue
        try:
            raw = value.decode("latin-1").strip()
        except UnicodeDecodeError:
            return None
        return raw if raw and len(raw) <= _MAX_DEVICE_ID_LEN else None
    return None


class OriginDeviceMiddleware:
    """Bind ``X-Client-Device`` onto the request task for this HTTP request."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        token = bind_origin_device(_device_id_from_scope(scope))
        try:
            await self.app(scope, receive, send)
        finally:
            reset_origin_device(token)
