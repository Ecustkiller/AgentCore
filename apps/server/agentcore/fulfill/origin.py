"""Which device started this turn — CLIENT_TOOL delivery affinity (来源设备).

A CLIENT_TOOL op runs on the *user's own machine*, so "which machine" becomes a
real product question the moment two desktops are online for one account: a
shell command, a file write or a directory mount belongs to the desk the user is
sitting at, not to whichever install happened to reconnect last.

The answer rides the turn's own HTTP request (``X-Client-Device``, bound by
:class:`~agentcore.middleware.origin_device.OriginDeviceMiddleware`) rather than
a conversation column — continuing yesterday's chat from a new laptop must
follow the new laptop. Turns that start without one (mobile / web / scheduled
workflow / sidecar) leave it unbound, and selection then behaves exactly as it
did before multi-device pinning existed.

Scope discipline: a turn task inherits the binding because ``create_task``
copies the request context. Work that starts *outside* that copy must not read a
neighbour's device by accident, so:

- deferred turns (conversation queue / steer promotion / cold resume) snapshot
  the value on their carrier and re-bind it here at drain;
- anything that outlives the turn (rehang on fulfiller reconnect, cancel after a
  user stop) reads the copy stamped onto the pending CLIENT_TOOL payload — see
  ``runtime/events/client_tool_reattach``.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar, Token

# The device id declared by the client that drove this turn, or None when the
# caller is not a fulfiller (mobile / web) or the turn has no originating request.
_origin_device: ContextVar[str | None] = ContextVar("origin_device_id", default=None)

# Shared user-facing fragment for a pinned op whose machine left mid-turn. Says
# what happened and that the op was NOT quietly moved — another device of this
# account may well be online, so "桌面未连接" would read as a lie.
ORIGIN_DEVICE_OFFLINE = (
    "发起本回合的设备不在线（该操作只能在这台设备上执行，不会转投其他设备）。"
    "请在那台电脑上打开客户端并登录后重试。"
)


def current_origin_device() -> str | None:
    """The device that started this turn, or ``None`` when unknown."""
    return _origin_device.get()


def bind_origin_device(device_id: str | None) -> Token[str | None]:
    """Bind the origin device for this context; returns the reset token.

    An empty / blank id binds ``None`` so a header the client sent but could not
    fill never masquerades as a real device.
    """
    cleaned = (device_id or "").strip() or None
    return _origin_device.set(cleaned)


def reset_origin_device(token: Token[str | None]) -> None:
    """Restore the binding replaced by :func:`bind_origin_device`."""
    _origin_device.reset(token)


@contextmanager
def origin_device(device_id: str | None) -> Iterator[None]:
    """Scoped binding — use around a deferred turn's task creation.

    Always sets (never merges): a queued turn from another machine must override
    the host turn's ambient device rather than inherit it.
    """
    token = bind_origin_device(device_id)
    try:
        yield
    finally:
        reset_origin_device(token)
