"""In-process hub for the device-level CLIENT_TOOL fulfillment channel.

Unlike the conversation EventSink (who is watching the turn) and the IM
``ChatHub`` (user-level notify firehose), this hub answers: which *online
device* of this user can execute a given channel op against a given root, and
delivers the request frame to that device's SSE subscription.

Multi-device is first-class: each ``(user_id, device_id)`` holds at most one
live :class:`FulfillerSession`. Selection prefers the most recently registered
session whose ``caps`` include the channel and whose ``roots`` hold the
``root_id`` (any capable session when ``root_id`` is ``None``).

Backpressure: fulfillment frames must not be silently shed. A full queue marks
the session unhealthy — it is closed so the client reconnects (and is removed
from the hub). Contrast ``ChatHub``, which drops the oldest undelivered event.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# Channels a fulfiller may advertise via the ``caps`` query param.
FULFILL_CHANNELS: frozenset[str] = frozenset(
    {
        "workspace",
        "host",
        "mcp",
        "board",
        "board_read",
        "notify",
        "external_mount",
    }
)

# A stalled fulfiller's queue is capped here; once full the session is closed
# (never drop-oldest). Sized above typical concurrent CLIENT_TOOL in-flight so
# only a genuinely stuck client trips the health gate.
_FULFILLER_QUEUE_MAXSIZE = 128


@dataclass
class FulfillerIdentity:
    """Stable connection identity declared at SSE open (plus mutable roots)."""

    user_id: str
    device_id: str
    platform: str | None
    caps: frozenset[str]
    roots: set[str] = field(default_factory=set)


class FulfillerSession:
    """One live ``GET /v1/fulfill`` connection's event queue + declared caps/roots.

    Drive it from the SSE route via :meth:`get` (or async iteration). It ends when
    the hub delivers the ``None`` sentinel (:meth:`close`). On client disconnect
    the route unregisters it from the hub.
    """

    def __init__(self, identity: FulfillerIdentity, *, registered_at: float) -> None:
        self.identity = identity
        self.registered_at = registered_at
        self._queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue(
            maxsize=_FULFILLER_QUEUE_MAXSIZE
        )
        self._closed = False

    @property
    def user_id(self) -> str:
        return self.identity.user_id

    @property
    def device_id(self) -> str:
        return self.identity.device_id

    @property
    def platform(self) -> str | None:
        return self.identity.platform

    @property
    def caps(self) -> frozenset[str]:
        return self.identity.caps

    @property
    def roots(self) -> set[str]:
        return self.identity.roots

    def update_roots(self, roots: Iterable[str]) -> None:
        """Replace the declared root set without reconnecting."""
        self.identity.roots = {r for r in roots if r}

    def offer(self, event: dict[str, Any]) -> bool:
        """Enqueue ``event``. Returns ``False`` when the queue is full (unhealthy).

        Unlike the IM firehose, a full queue must not shed the oldest frame —
        callers close the session instead.
        """
        if self._closed:
            return False
        try:
            self._queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            return False

    def close(self) -> None:
        """Signal end-of-stream (drain backlog, then sentinel). Idempotent."""
        if self._closed:
            return
        self._closed = True
        while True:
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        with contextlib.suppress(asyncio.QueueFull):
            self._queue.put_nowait(None)

    async def get(self) -> dict[str, Any] | None:
        """Await the next event, or ``None`` once the stream is closed."""
        return await self._queue.get()

    async def __aiter__(self) -> AsyncIterator[dict[str, Any]]:
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event


class FulfillerHub:
    """Process-wide registry of live fulfillment sessions + query/deliver helpers."""

    def __init__(self) -> None:
        # user_id → live sessions (multi-device).
        self._by_user: dict[str, set[FulfillerSession]] = {}
        # (user_id, device_id) → session (at most one live connection per device).
        self._by_device: dict[tuple[str, str], FulfillerSession] = {}

    def register(
        self,
        user_id: str,
        device_id: str,
        *,
        caps: Iterable[str],
        roots: Iterable[str] | None = None,
        platform: str | None = None,
    ) -> FulfillerSession:
        """Register (or replace) a live fulfillment connection for ``device_id``.

        Reconnecting the same device closes the previous session first so caps /
        roots always reflect the newest subscription.
        """
        key = (user_id, device_id)
        existing = self._by_device.get(key)
        if existing is not None:
            self.unregister(existing)

        cap_set = frozenset(c for c in caps if c in FULFILL_CHANNELS)
        identity = FulfillerIdentity(
            user_id=user_id,
            device_id=device_id,
            platform=platform,
            caps=cap_set,
            roots={r for r in (roots or ()) if r},
        )
        session = FulfillerSession(identity, registered_at=time.monotonic())
        self._by_user.setdefault(user_id, set()).add(session)
        self._by_device[key] = session
        logger.info(
            "fulfill.register",
            user=user_id,
            device=device_id,
            platform=platform,
            caps=sorted(cap_set),
            roots=len(identity.roots),
            devices=len(self._by_user.get(user_id, ())),
        )
        return session

    def unregister(self, session: FulfillerSession) -> None:
        """Remove a connection (on disconnect / unhealthy close). Idempotent."""
        key = (session.user_id, session.device_id)
        if self._by_device.get(key) is session:
            self._by_device.pop(key, None)
        conns = self._by_user.get(session.user_id)
        if conns is not None:
            conns.discard(session)
            if not conns:
                self._by_user.pop(session.user_id, None)
        session.close()
        logger.info(
            "fulfill.unregister",
            user=session.user_id,
            device=session.device_id,
        )

    def update_roots(self, user_id: str, device_id: str, roots: Iterable[str]) -> bool:
        """Update an online session's root set. Returns ``False`` when not online."""
        session = self._by_device.get((user_id, device_id))
        if session is None:
            return False
        session.update_roots(roots)
        logger.info(
            "fulfill.roots_updated",
            user=user_id,
            device=device_id,
            roots=len(session.roots),
        )
        return True

    def get_session(self, user_id: str, device_id: str) -> FulfillerSession | None:
        """Return the live session for ``(user_id, device_id)``, if any."""
        return self._by_device.get((user_id, device_id))

    def find(
        self,
        user_id: str,
        *,
        root_id: str | None,
        channel: str,
    ) -> FulfillerSession | None:
        """Pick the best online fulfiller for ``channel`` (+ optional ``root_id``).

        Rules: caps contain ``channel`` → roots contain ``root_id`` (any capable
        session when ``root_id`` is ``None``) → most recently registered.
        """
        sessions = self._by_user.get(user_id)
        if not sessions:
            return None
        candidates = [
            s
            for s in sessions
            if channel in s.caps and (root_id is None or root_id in s.roots)
        ]
        if not candidates:
            return None
        return max(candidates, key=lambda s: s.registered_at)

    def has_fulfiller(
        self,
        user_id: str,
        *,
        root_id: str | None,
        channel: str,
    ) -> bool:
        """True when :meth:`find` would return a live session."""
        return self.find(user_id, root_id=root_id, channel=channel) is not None

    def deliver(self, session: FulfillerSession, event: dict[str, Any]) -> bool:
        """Push ``event`` onto ``session``. On queue-full, close it and return False."""
        if session.offer(event):
            return True
        logger.warning(
            "fulfill.queue_full_close",
            user=session.user_id,
            device=session.device_id,
            type=event.get("type"),
            qsize=_FULFILLER_QUEUE_MAXSIZE,
        )
        self.unregister(session)
        return False

    def connection_count(self, user_id: str) -> int:
        """How many live fulfillment connections ``user_id`` currently holds."""
        return len(self._by_user.get(user_id, ()))


_hub = FulfillerHub()


def default_fulfiller_hub() -> FulfillerHub:
    """The process-wide fulfiller hub (shared by the route + dispatch seam)."""
    return _hub
