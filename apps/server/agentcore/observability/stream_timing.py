"""Monotonic + wall-clock helpers for SSE age / idle fields.

Client stall watchdogs look at *idle* (time since the last byte, including
``: ping`` heartbeats), not connection age. Emit sites share this clock so
``duration_ms`` / ``idle_ms`` / ``started_at`` stay comparable across
``event_sink.detach`` and ``conversation_stream.unwatch``.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime


def mono_now() -> float:
    """Monotonic seconds; patchable in tests."""
    return time.monotonic()


def wall_now_iso() -> str:
    """UTC wall clock for ``started_at`` (millisecond ISO-8601)."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def elapsed_ms(started_mono: float, *, now_mono: float | None = None) -> int:
    """Non-negative milliseconds from ``started_mono`` to now."""
    now = mono_now() if now_mono is None else now_mono
    return max(0, int(round((now - started_mono) * 1000)))


def current_http_req_id() -> str | None:
    """Request id stamped by ``RequestAttributionMiddleware``, if this task has one."""
    from structlog.contextvars import get_contextvars

    raw = get_contextvars().get("http_req_id")
    return str(raw) if raw else None


# GET /stream?follow=  vs  default attach  vs  POST turn SSE.
_MODE_BY_LABEL = {
    "attach": "attach",
    "resume_settled_join": "attach",
    "conversation_stream": "follow",
    "turn_stream": "turn",
}


def consumer_mode(label: str) -> str:
    """Map subscribe label → attach | follow | turn | other."""
    return _MODE_BY_LABEL.get(label, "other")
