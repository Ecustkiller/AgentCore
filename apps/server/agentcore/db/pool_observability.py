"""Pool checkout holder tracking — name who holds connections when the pool dies.

Hot path is intentionally near-zero cost: every checkout stores only a monotonic
timestamp plus already-bound log contextvars. Stack frames are captured only
when pool occupancy crosses a settings threshold. Slow checkins and exhaustion
snapshots are the only places that emit logs.
"""

from __future__ import annotations

import asyncio
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import event
from sqlalchemy.exc import TimeoutError as SATimeoutError

from agentcore.core.log_context import get_log_value
from agentcore.core.logging import get_logger

logger = get_logger(__name__)

# Correlation keys worth attributing a checkout to a turn / background job.
_CTX_KEYS = (
    "trace_id",
    "conversation_id",
    "run_id",
    "agent_id",
    "attempt_id",
    "message_id",
    "user_id",
)

# Frames under these path fragments are skipped when recording a checkout stack
# (paths are normalized to ``/`` before matching).
_STACK_SKIP_MARKERS = (
    "sqlalchemy",
    "greenlet",
    "agentcore/db/pool_observability.py",
)


@dataclass(slots=True)
class CheckoutRecord:
    """One currently-checked-out pool connection."""

    conn_key: int
    checked_out_at: float
    context: dict[str, str]
    task_name: str = ""
    stack: tuple[str, ...] = ()


@dataclass
class PoolCheckoutTracker:
    """Tracks holders for one QueuePool (primary or telemetry)."""

    name: str
    capacity: int
    hold_warn_s: float
    trace_occupancy: float
    stack_frames: int
    snapshot_cooldown_s: float
    _holders: dict[int, CheckoutRecord] = field(default_factory=dict, init=False, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)
    _last_snapshot_at: float = field(default=0.0, init=False, repr=False)
    _installed: bool = field(default=False, init=False, repr=False)
    _orig_do_get: Any = field(default=None, init=False, repr=False)

    # --- install -----------------------------------------------------------

    def install(self, async_engine: Any) -> None:
        """Attach checkout/checkin listeners and wrap pool ``_do_get`` for timeouts."""
        if self._installed:
            return
        sync_engine = async_engine.sync_engine
        event.listen(sync_engine, "checkout", self._on_checkout)
        event.listen(sync_engine, "checkin", self._on_checkin)
        event.listen(sync_engine, "invalidate", self._on_invalidate)

        self._installed = True

        # SQLAlchemy has no public "pool timeout" event, and most exhaustion happens
        # in background tasks that never reach ``get_session``. Wrapping the private
        # ``_do_get`` is the only way to snapshot every path — so it must degrade to
        # "no snapshot" rather than break boot if a future release renames it.
        pool = sync_engine.pool
        orig = getattr(pool, "_do_get", None)
        if not callable(orig):
            logger.warning("db.pool_tracker_no_timeout_hook", pool=self.name)
            return
        tracker = self

        def _do_get_tracked() -> Any:
            try:
                return orig()
            except SATimeoutError:
                tracker.emit_exhaustion_snapshot()
                raise

        pool._do_get = _do_get_tracked  # type: ignore[method-assign]
        self._orig_do_get = orig

    # --- event handlers (sync, must stay cheap) ----------------------------

    def _on_checkout(
        self,
        _dbapi_connection: Any,
        connection_record: Any,
        _connection_proxy: Any,
    ) -> None:
        key = id(connection_record)
        now = time.monotonic()
        # Always-on path: contextvars copy + task name — no stack, no I/O.
        context = _capture_log_context()
        task_name = _current_task_name()

        with self._lock:
            count_after = len(self._holders) + (0 if key in self._holders else 1)
        occupancy_after = count_after / max(self.capacity, 1)
        # Stack only when the pool is already under pressure (off the common path).
        stack: tuple[str, ...] = ()
        if occupancy_after >= self.trace_occupancy and self.stack_frames > 0:
            stack = _capture_stack(self.stack_frames)

        with self._lock:
            self._holders[key] = CheckoutRecord(
                conn_key=key,
                checked_out_at=now,
                context=context,
                task_name=task_name,
                stack=stack,
            )

    def _on_checkin(self, _dbapi_connection: Any, connection_record: Any) -> None:
        key = id(connection_record)
        now = time.monotonic()
        with self._lock:
            record = self._holders.pop(key, None)
        if record is None:
            return
        held_s = now - record.checked_out_at
        if held_s >= self.hold_warn_s:
            logger.warning(
                "db.pool_checkout_slow",
                pool=self.name,
                held_s=round(held_s, 3),
                task_name=record.task_name or None,
                stack=list(record.stack) or None,
                **record.context,
            )

    def _on_invalidate(
        self,
        _dbapi_connection: Any,
        connection_record: Any,
        _exception: Any,
    ) -> None:
        # Drop holder metadata if the slot is invalidated while checked out;
        # a subsequent checkout will re-record.
        key = id(connection_record)
        with self._lock:
            self._holders.pop(key, None)

    # --- snapshots ---------------------------------------------------------

    def holder_snapshots(self, *, now: float | None = None) -> list[dict[str, Any]]:
        """Current holders as plain dicts (for logs / tests)."""
        ts = time.monotonic() if now is None else now
        with self._lock:
            records = list(self._holders.values())
        out: list[dict[str, Any]] = []
        for rec in sorted(records, key=lambda r: r.checked_out_at):
            entry: dict[str, Any] = {
                "held_s": round(ts - rec.checked_out_at, 3),
                "task_name": rec.task_name or None,
                **rec.context,
            }
            if rec.stack:
                entry["stack"] = list(rec.stack)
            out.append(entry)
        return out

    def emit_exhaustion_snapshot(self) -> None:
        """Log one holder snapshot for this pool (cooldown-deduped)."""
        now = time.monotonic()
        with self._lock:
            if now - self._last_snapshot_at < self.snapshot_cooldown_s:
                return
            self._last_snapshot_at = now
            checked_out = len(self._holders)
        holders = self.holder_snapshots(now=now)
        logger.warning(
            "db.pool_exhausted_snapshot",
            pool=self.name,
            checked_out=checked_out,
            capacity=self.capacity,
            holders=holders,
        )


def _capture_log_context() -> dict[str, str]:
    """Copy cheap correlation ids already bound on this task (no I/O)."""
    out: dict[str, str] = {}
    for key in _CTX_KEYS:
        value = get_log_value(key)
        if value:
            out[key] = value
    return out


def _current_task_name() -> str:
    try:
        task = asyncio.current_task()
    except RuntimeError:
        return ""
    if task is None:
        return ""
    name = task.get_name()
    return name if name else ""


def _capture_stack(max_frames: int) -> tuple[str, ...]:
    """Nearest app frames that requested the connection (innermost-first walk).

    ``walk_stack`` avoids the source-line lookup ``extract_stack`` performs, and
    walking inward-out keeps the frames adjacent to the checkout — those name the
    holder, unlike the outer ASGI frames every request shares.
    """
    kept: list[str] = []
    for frame, lineno in traceback.walk_stack(None):
        filename = frame.f_code.co_filename
        path = filename.replace("\\", "/")
        if any(marker in path for marker in _STACK_SKIP_MARKERS):
            continue
        kept.append(f"{filename}:{lineno}:{frame.f_code.co_name}")
        if len(kept) >= max_frames:
            break
    kept.reverse()
    return tuple(kept)


def install_pool_trackers(
    *,
    primary_engine: Any,
    telemetry_engine: Any,
    primary_capacity: int,
    telemetry_capacity: int,
    hold_warn_s: float,
    trace_occupancy: float,
    stack_frames: int,
    snapshot_cooldown_s: float,
) -> tuple[PoolCheckoutTracker, PoolCheckoutTracker]:
    """Install trackers on both app pools. Returns ``(primary, telemetry)``."""
    primary = PoolCheckoutTracker(
        name="primary",
        capacity=primary_capacity,
        hold_warn_s=hold_warn_s,
        trace_occupancy=trace_occupancy,
        stack_frames=stack_frames,
        snapshot_cooldown_s=snapshot_cooldown_s,
    )
    telemetry = PoolCheckoutTracker(
        name="telemetry",
        capacity=telemetry_capacity,
        hold_warn_s=hold_warn_s,
        trace_occupancy=trace_occupancy,
        stack_frames=stack_frames,
        snapshot_cooldown_s=snapshot_cooldown_s,
    )
    primary.install(primary_engine)
    telemetry.install(telemetry_engine)
    return primary, telemetry
