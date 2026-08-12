"""Bind HTTP request identity for pool-holder attribution.

Checkout listeners can only see what is already on the task's contextvars /
task name. Turn-level ids (trace / conversation / …) are often unbound when a
request session is checked out, so every HTTP request binds a cheap method +
path + short req id *before* any handler runs.

Pure ASGI (not BaseHTTPMiddleware) so it shares the same task as the route
handler — the place where ``get_session`` checkouts actually happen.
"""

from __future__ import annotations

import asyncio
from uuid import uuid4

from starlette.types import ASGIApp, Receive, Scope, Send
from structlog.contextvars import bound_contextvars


class RequestAttributionMiddleware:
    """Stamp ``http_method`` / ``http_path`` / ``http_req_id`` onto the request task."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method") or "?")
        path = str(scope.get("path") or "?")
        req_id = uuid4().hex[:12]

        task = asyncio.current_task()
        if task is not None:
            # Replace the useless BaseHTTPMiddleware coro name so snapshots can
            # answer "which request" from ``task_name`` alone.
            task.set_name(f"http:{method} {path}")

        with bound_contextvars(
            http_method=method,
            http_path=path,
            http_req_id=req_id,
        ):
            await self.app(scope, receive, send)
