"""Coalesce per-drop backpressure logs: first hit + heartbeat + end flush.

A stalled SSE / firehose consumer sheds oldest frames from a 1000-deep queue.
Logging one jsonl line per shed frame floods the product log during a token
stream (hundreds/sec) and buries the onset. Delivery is unchanged — this only
rates the *log*.

Thresholds (why these numbers):

- **First drop** emits immediately so the start of shedding is visible.
- **Count = 1000** (one full queue of further loss): a same-tick burst cannot
  write more than ~1 line per queue-worth, independent of frame rate.
- **Interval = 1.0s**: a multi-second storm still shows "still shedding" at
  ~1 line/s — far coarser than per-frame, tighter than SSE idle heartbeats
  (15–25s) so a live drop storm is distinguishable from a quiet connection.
- **Subscription/connection end** flushes the remainder so the total is never
  silently truncated.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

# Looked up at call time so tests can freeze it without injecting a clock.
_now = time.monotonic

DEFAULT_EVERY = 1000
DEFAULT_INTERVAL_S = 1.0


@dataclass(frozen=True, slots=True)
class DropPulse:
    """One coalesced backpressure log payload (call site still emits the event)."""

    dropped_delta: int
    dropped_total: int
    event_type: str | None = None


class DropLogHeartbeat:
    """Per-subscription drop counter that yields a pulse only at heartbeat points."""

    __slots__ = ("_event_type", "_every", "_interval_s", "_last_emit_at", "_total", "_unlogged")

    def __init__(
        self,
        *,
        every: int = DEFAULT_EVERY,
        interval_s: float = DEFAULT_INTERVAL_S,
    ) -> None:
        if every < 1:
            raise ValueError("every must be >= 1")
        self._every = every
        self._interval_s = interval_s
        self._total = 0
        self._unlogged = 0
        self._last_emit_at: float | None = None
        self._event_type: str | None = None

    def note(self, event_type: str | None = None) -> DropPulse | None:
        """Record one shed frame. Return a pulse when a log line should fire."""
        if event_type is not None:
            self._event_type = event_type
        self._total += 1
        self._unlogged += 1
        if not self._should_emit():
            return None
        return self._take()

    def flush(self) -> DropPulse | None:
        """Emit leftover drops when the subscription / connection ends."""
        if self._unlogged <= 0:
            return None
        return self._take()

    def _should_emit(self) -> bool:
        if self._total == 1:
            return True
        if self._unlogged >= self._every:
            return True
        last = self._last_emit_at
        return last is not None and (_now() - last) >= self._interval_s

    def _take(self) -> DropPulse:
        delta = self._unlogged
        self._unlogged = 0
        self._last_emit_at = _now()
        return DropPulse(
            dropped_delta=delta,
            dropped_total=self._total,
            event_type=self._event_type,
        )
