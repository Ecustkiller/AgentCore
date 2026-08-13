"""Reconnect grace — hold one CLIENT_TOOL op unsettled while its device returns.

A desktop's fulfill SSE drops and re-opens many times a day (one production user:
62 times in a day, back within 1–4s). A turn that dispatches an op inside that
blind window finds an empty hub and, before this, failed the op on the spot —
twice in that same day, enough to trip the tool circuit breaker on a machine that
never left.

This module is only the *timer*: :func:`hold` parks a request id for a bounded
number of seconds and calls back if nobody claimed it by then. Deciding whether a
delivery miss deserves the wait (the device was here a moment ago) and what to do
when the wait ends both stay with
:func:`~agentcore.runtime.events.client_tool_reattach.push_client_tool_required`;
re-delivery on reconnect stays with ``rehang_pending_client_tools`` (which is
also where the observability lives). Nothing here polls or retries — the
reconnect itself is the wake-up.

State is in-process, like the interaction registry and the hub these timers
shadow (single-worker posture — see ``config.py``).
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable

# Longest an op may stay unsettled waiting for its device. Reconnects land in
# 1–4s with a tail into the teens, so this covers the observed tail with margin;
# past it the honest answer is that the client is gone.
RECONNECT_GRACE_SECONDS = 20.0

# Kept between the grace expiry and the op's own deadline so the typed failure
# still lands as a *settle* (the channel's copy) rather than as a timeout.
_DEADLINE_SLACK_SECONDS = 1.0

# request_id → pending expiry timer.
_holds: dict[str, asyncio.TimerHandle] = {}


def window_for(deadline_seconds: float | None) -> float:
    """Grace this op may take, clamped under its own deadline (0 = none).

    An op must never wait past the deadline its channel already promised, so a
    short-deadline op keeps today's immediate failure instead of trading one
    honest error for a timeout.
    """
    if deadline_seconds is None:
        return RECONNECT_GRACE_SECONDS
    return min(RECONNECT_GRACE_SECONDS, deadline_seconds - _DEADLINE_SLACK_SECONDS)


def hold(request_id: str, *, seconds: float, on_expire: Callable[[], None]) -> bool:
    """Park ``request_id`` for ``seconds``, then call ``on_expire``.

    Returns ``False`` when the caller must settle right now instead: a
    non-positive window, or no running loop to schedule on. Re-holding the same
    id replaces the previous timer.
    """
    if seconds <= 0:
        return False
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    release(request_id)

    def _expire() -> None:
        _holds.pop(request_id, None)
        on_expire()

    _holds[request_id] = loop.call_later(seconds, _expire)
    return True


def release(request_id: str) -> bool:
    """Cancel a pending hold (the op was delivered / is gone). Idempotent."""
    timer = _holds.pop(request_id, None)
    if timer is None:
        return False
    timer.cancel()
    return True


def is_held(request_id: str) -> bool:
    """True while ``request_id`` is parked waiting for its device to come back."""
    return request_id in _holds
