"""Pool checkout holder tracking — name who holds connections when the pool dies.

Hot path is intentionally near-zero cost: every checkout stores only a monotonic
timestamp plus already-bound log contextvars (incl. HTTP method/path/req id).
Stack frames are captured only when pool occupancy crosses a settings threshold,
preferring the *asyncio task* coroutine stack (the greenlet trampoline that
fires the SQLAlchemy checkout event hides the caller from the sync stack) and
falling back to the synchronous stack. Slow checkins and exhaustion snapshots
are the only places that emit logs.
"""

from __future__ import annotations

import asyncio
import sys
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

# Correlation keys worth attributing a checkout to a turn / HTTP request /
# background job. Bound at the boundary that first knows them; empty at
# checkout time means that boundary never ran (do not try to recover later).
_CTX_KEYS = (
    "trace_id",
    "conversation_id",
    "run_id",
    "agent_id",
    "attempt_id",
    "message_id",
    "user_id",
    # HTTP request identity (RequestAttributionMiddleware) — the only keys that
    # are reliably present for request-scoped sessions that never start a turn.
    "http_method",
    "http_path",
    "http_req_id",
)

# Path fragments skipped when recording a checkout stack (normalized to ``/``).
_STACK_SKIP_MARKERS = (
    "sqlalchemy",
    "greenlet",
    "agentcore/db/pool_observability.py",
    "starlette/middleware",
    "uvicorn/",
)

# Generic vendor roots, skipped only for frames that are *not* ours: a
# non-editable install (``uv sync --no-editable``) puts ``agentcore/`` itself
# under site-packages, and blanket-skipping those would leave every snapshot
# with zero business frames while the tests (source tree) still passed.
_VENDOR_STACK_MARKERS = ("/site-packages/", "/lib/python")

# Greenlet/SQLAlchemy compile trampolines show up as ``<string>`` with these names.
_STACK_SKIP_FILENAMES = frozenset({"<string>", "<stdin>"})
_STACK_SKIP_NAMES = frozenset(
    {
        "_connection_for_bind",
        "_connection_cls_for_bind",
        "_do_get",
        "_checkout",
        "greenlet_spawn",
    }
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


def _frame_is_noise(filename: str, name: str) -> bool:
    if filename in _STACK_SKIP_FILENAMES:
        return True
    if name in _STACK_SKIP_NAMES:
        return True
    path = filename.replace("\\", "/")
    if any(marker in path for marker in _STACK_SKIP_MARKERS):
        return True
    if _frame_is_app(filename):
        return False
    return any(marker in path for marker in _VENDOR_STACK_MARKERS)


def _frame_is_app(filename: str) -> bool:
    return "agentcore/" in filename.replace("\\", "/")


def _format_frame(filename: str, lineno: int, name: str) -> str:
    return f"{filename}:{lineno}:{name}"


def _task_stack_frames(max_frames: int) -> list[tuple[str, int, str]]:
    """Coroutine await chain of the running task, newest-first (empty if none)."""
    try:
        task: asyncio.Task[Any] | None = asyncio.current_task()
    except RuntimeError:
        return []
    if task is None:
        return []
    # Oversample then filter; get_stack is oldest→newest, reverse so we prefer
    # frames adjacent to the await that checked out.
    return [
        (frame.f_code.co_filename, frame.f_lineno, frame.f_code.co_name)
        for frame in reversed(task.get_stack(limit=max(32, max_frames * 4)))
    ]


def _sync_stack_frames() -> list[tuple[str, int, str]]:
    """Synchronous caller frames, newest-first.

    The start frame is explicit: ``walk_stack(None)`` drops a fixed number of
    ``f_back`` hops sized for ``StackSummary.extract``'s call chain (four on
    3.13), so with ``None`` the frames we actually skip would silently shift
    with our own call depth.
    """
    return [
        (frame.f_code.co_filename, lineno, frame.f_code.co_name)
        for frame, lineno in traceback.walk_stack(sys._getframe())
    ]


def _split_frames(
    frames: list[tuple[str, int, str]], max_frames: int
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Partition newest-first frames into (app, other), outermost-first and capped."""
    app: list[str] = []
    other: list[str] = []
    for filename, lineno, name in frames:
        if _frame_is_noise(filename, name):
            continue
        label = _format_frame(filename, lineno, name)
        if _frame_is_app(filename):
            app.append(label)
            if len(app) >= max_frames:
                break
        elif len(other) < max_frames:
            other.append(label)
    app.reverse()  # outermost-first for log readability
    other.reverse()
    return tuple(app), tuple(other)


def _capture_stack(max_frames: int) -> tuple[str, ...]:
    """App frames that requested the connection (outermost-first).

    Two complementary sources, tried in order — neither alone is sufficient:
    ``asyncio.Task.get_stack`` walks the coroutine await chain (route handler →
    service → repository), which is the *only* view of the caller when checkout
    fires inside SQLAlchemy's greenlet trampoline and the synchronous stack
    shows nothing but ``<string>``. That synchronous stack is in turn the only
    source when no task is running, or when the task's coroutine frames are all
    trampoline noise. Falling back matters: an empty ``stack`` is
    indistinguishable from "nobody was holding it".
    """
    fallback: tuple[str, ...] = ()
    for frames in (_task_stack_frames(max_frames), _sync_stack_frames()):
        app, other = _split_frames(frames, max_frames)
        if app:
            return app
        fallback = fallback or other
    return fallback


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
