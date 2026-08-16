"""Cheap event-loop lag probe for the single-process uvicorn.

One ``asyncio.sleep`` per second: the overrun *is* the stall. A 10s freeze
produces one ``event_loop.lag`` line with ``lag_ms≈10000``, not a flood.
A 60s ``event_loop.lag_summary`` answers「当时卡没卡」even when nothing
crossed the warning threshold.

No extra threads, no extra dependencies — just ``loop.time()``.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from agentcore.core.logging import get_logger
from agentcore.observability.stream_timing import mono_now

logger = get_logger(__name__)

DEFAULT_INTERVAL_S = 1.0
DEFAULT_WARN_LAG_S = 0.25
DEFAULT_SUMMARY_S = 60.0
# First stall always logs; repeats while still over threshold at most every 10s
# so a 300ms-steady load does not write 1 warning/s into the patrol family.
DEFAULT_WARN_REPEAT_S = 10.0


@dataclass(frozen=True, slots=True)
class LagPulse:
    """One structured log line the loop should emit."""

    event: str
    payload: dict[str, object]


@dataclass
class LagWindow:
    """Accumulate 1 Hz samples; emit a warning on stall and a periodic summary."""

    interval_s: float = DEFAULT_INTERVAL_S
    warn_lag_s: float = DEFAULT_WARN_LAG_S
    summary_s: float = DEFAULT_SUMMARY_S
    warn_repeat_s: float = DEFAULT_WARN_REPEAT_S
    _max_lag_s: float = 0.0
    _samples: int = 0
    _over: int = 0
    _suppressed: int = 0
    _last_warn_mono: float | None = None
    _window_started_mono: float = field(default_factory=mono_now)

    def note(self, lag_s: float, *, now_mono: float | None = None) -> list[LagPulse]:
        """Record one sample. Return pulses that should be logged now."""
        now = mono_now() if now_mono is None else now_mono
        lag_s = max(0.0, lag_s)
        self._samples += 1
        if lag_s > self._max_lag_s:
            self._max_lag_s = lag_s
        pulses: list[LagPulse] = []
        if lag_s >= self.warn_lag_s:
            self._over += 1
            last = self._last_warn_mono
            due = last is None or (now - last) >= self.warn_repeat_s
            if due:
                pulses.append(
                    LagPulse(
                        event="event_loop.lag",
                        payload={
                            "lag_ms": int(round(lag_s * 1000)),
                            "interval_s": self.interval_s,
                            "threshold_ms": int(round(self.warn_lag_s * 1000)),
                            "suppressed": self._suppressed,
                        },
                    )
                )
                self._last_warn_mono = now
                self._suppressed = 0
            else:
                self._suppressed += 1
        if now - self._window_started_mono >= self.summary_s:
            pulses.append(self._take_summary())
            self._window_started_mono = now
        return pulses

    def _take_summary(self) -> LagPulse:
        pulse = LagPulse(
            event="event_loop.lag_summary",
            payload={
                "max_lag_ms": int(round(self._max_lag_s * 1000)),
                "samples": self._samples,
                "over_threshold": self._over,
                "threshold_ms": int(round(self.warn_lag_s * 1000)),
                "window_s": self.summary_s,
            },
        )
        self._max_lag_s = 0.0
        self._samples = 0
        self._over = 0
        return pulse


def _emit(pulse: LagPulse) -> None:
    # Literal event names so sync_log_event_registry.py can see the call sites.
    if pulse.event == "event_loop.lag":
        logger.warning("event_loop.lag", **pulse.payload)
    else:
        logger.info("event_loop.lag_summary", **pulse.payload)


async def event_loop_lag_loop(
    *,
    interval_s: float = DEFAULT_INTERVAL_S,
    warn_lag_s: float = DEFAULT_WARN_LAG_S,
    summary_s: float = DEFAULT_SUMMARY_S,
) -> None:
    """Run until cancelled. Shutdown must not emit lag or a leftover summary.

    Cancel hits ``asyncio.sleep``; we re-raise without flushing. Shutdown itself
    stalls the loop (turn salvage), so a last sample would be a false stall.
    There is no second 60s task — ``lag_summary`` is the same loop.
    """
    loop = asyncio.get_running_loop()
    window = LagWindow(interval_s=interval_s, warn_lag_s=warn_lag_s, summary_s=summary_s)
    try:
        while True:
            t0 = loop.time()
            await asyncio.sleep(interval_s)
            lag = loop.time() - t0 - interval_s
            for pulse in window.note(lag, now_mono=loop.time()):
                _emit(pulse)
    except asyncio.CancelledError:
        raise
