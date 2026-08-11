"""Pool holder observability: exhaustion snapshot + slow checkout."""

from __future__ import annotations

import time

import pytest
from sqlalchemy.exc import TimeoutError as SATimeoutError

from agentcore.config.database import DatabaseSettings
from agentcore.core.log_context import bind_log_context, clear_log_context
from agentcore.db import pool_observability as pool_obs
from agentcore.db.pool_observability import PoolCheckoutTracker
from tests.conftest import LogSpy


class _FakeRecord:
    """Stand-in for SQLAlchemy ConnectionPoolEntry (identity-keyed)."""


def _tracker(**overrides: object) -> PoolCheckoutTracker:
    defaults: dict[str, object] = {
        "name": "primary",
        "capacity": 4,
        "hold_warn_s": 0.05,
        "trace_occupancy": 0.75,
        "stack_frames": 4,
        "snapshot_cooldown_s": 0.0,
    }
    defaults.update(overrides)
    return PoolCheckoutTracker(**defaults)  # type: ignore[arg-type]


@pytest.fixture(autouse=True)
def _clear_log_ctx() -> None:
    clear_log_context()
    yield
    clear_log_context()


def test_pool_observability_settings_defaults_are_conservative() -> None:
    fields = DatabaseSettings.model_fields
    assert fields["db_pool_hold_warn_s"].default == 10.0
    assert fields["db_pool_trace_occupancy"].default == 0.75
    assert fields["db_pool_stack_frames"].default == 8
    assert fields["db_pool_exhaustion_snapshot_cooldown_s"].default == 5.0
    # Capacity defaults unchanged (observation must not expand the pool).
    assert fields["db_pool_size"].default == 16
    assert fields["db_max_overflow"].default == 16


def test_exhaustion_snapshot_includes_holder_context(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    bind_log_context(
        trace_id="aabbccddeeff00112233445566778899",
        conversation_id="conv-holder-1",
        run_id="run-holder-1",
        agent_id="agent-ceo",
    )
    tracker = _tracker(hold_warn_s=999.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker.emit_exhaustion_snapshot()

    payload = spy.get("db.pool_exhausted_snapshot")
    assert payload["pool"] == "primary"
    assert payload["checked_out"] == 1
    assert payload["capacity"] == 4
    holders = payload["holders"]
    assert isinstance(holders, list) and len(holders) == 1
    holder = holders[0]
    assert holder["trace_id"] == "aabbccddeeff00112233445566778899"
    assert holder["conversation_id"] == "conv-holder-1"
    assert holder["run_id"] == "run-holder-1"
    assert holder["agent_id"] == "agent-ceo"
    assert isinstance(holder["held_s"], float)
    assert holder["held_s"] >= 0.0


def test_slow_checkout_emits_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    bind_log_context(trace_id="slowtrace000000000000000000000001", conversation_id="conv-slow")
    tracker = _tracker(hold_warn_s=0.01, trace_occupancy=1.1)  # never capture stack
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    time.sleep(0.02)
    tracker._on_checkin(None, record)

    payload = spy.get("db.pool_checkout_slow")
    assert payload["pool"] == "primary"
    assert payload["held_s"] >= 0.01
    assert payload["trace_id"] == "slowtrace000000000000000000000001"
    assert payload["conversation_id"] == "conv-slow"


def test_fast_checkout_does_not_warn(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)
    tracker = _tracker(hold_warn_s=30.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker._on_checkin(None, record)
    assert not any(name == "db.pool_checkout_slow" for name, _ in spy.events)


def test_high_occupancy_captures_stack() -> None:
    tracker = _tracker(capacity=2, trace_occupancy=0.5, stack_frames=4)
    r1, r2 = _FakeRecord(), _FakeRecord()
    tracker._on_checkout(None, r1, None)
    tracker._on_checkout(None, r2, None)
    snaps = tracker.holder_snapshots()
    assert len(snaps) == 2
    # Second checkout is at 100% occupancy → stack present.
    assert snaps[1].get("stack")


def test_low_occupancy_skips_stack() -> None:
    tracker = _tracker(capacity=10, trace_occupancy=0.75, stack_frames=8)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    snaps = tracker.holder_snapshots()
    assert len(snaps) == 1
    assert "stack" not in snaps[0]


def test_snapshot_cooldown_dedupes(monkeypatch: pytest.MonkeyPatch) -> None:
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)
    tracker = _tracker(snapshot_cooldown_s=60.0)
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    tracker.emit_exhaustion_snapshot()
    tracker.emit_exhaustion_snapshot()
    assert sum(1 for name, _ in spy.events if name == "db.pool_exhausted_snapshot") == 1


def test_invalidate_drops_holder() -> None:
    tracker = _tracker()
    record = _FakeRecord()
    tracker._on_checkout(None, record, None)
    assert len(tracker.holder_snapshots()) == 1
    tracker._on_invalidate(None, record, None)
    assert tracker.holder_snapshots() == []


def test_do_get_wrapper_emits_snapshot_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wrapping pool._do_get is how every call site gets a holder snapshot."""
    spy = LogSpy()
    monkeypatch.setattr(pool_obs, "logger", spy)

    tracker = _tracker(snapshot_cooldown_s=0.0)
    holder = _FakeRecord()
    bind_log_context(trace_id="wraptrace00000000000000000000001", conversation_id="conv-wrap")
    tracker._on_checkout(None, holder, None)
    clear_log_context()

    class _Pool:
        def _do_get(self):
            raise SATimeoutError("QueuePool limit of size 2 overflow 0 reached")

    class _SyncEngine:
        def __init__(self) -> None:
            self.pool = _Pool()

    class _AsyncEngine:
        def __init__(self) -> None:
            self.sync_engine = _SyncEngine()

    # Bypass real event.listen; only exercise the _do_get wrap path.
    engine = _AsyncEngine()
    pool = engine.sync_engine.pool
    orig = pool._do_get

    def _do_get_tracked():
        try:
            return orig()
        except SATimeoutError:
            tracker.emit_exhaustion_snapshot()
            raise

    pool._do_get = _do_get_tracked  # type: ignore[method-assign]

    with pytest.raises(SATimeoutError):
        pool._do_get()

    payload = spy.get("db.pool_exhausted_snapshot")
    holders = payload["holders"]
    assert len(holders) == 1
    assert holders[0]["trace_id"] == "wraptrace00000000000000000000001"
    assert holders[0]["conversation_id"] == "conv-wrap"
