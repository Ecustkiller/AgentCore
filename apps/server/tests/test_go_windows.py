"""Unit tests for OpenCode Go window math (nominal nano-CNY, no FX)."""

import json
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from agentcore.billing.go_windows import (
    FIVE_HOURS,
    CallSpend,
    aggregate_go_windows,
    five_hour_window,
    go_window_credential_ids,
    subscription_month_bounds,
    utc_week_bounds,
)
from agentcore.config import settings
from agentcore.config.platform import PlatformSettings
from agentcore.llm.credentials import derive_platform_credential_id

_T0 = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
_GO = "https://opencode.ai/zen/go/v1"
_ZEN = "https://opencode.ai/zen/v1"


def _s(ts: datetime, nano: int, usd: int = 0) -> CallSpend:
    return CallSpend(created_at=ts, cost_total_nano=nano, estimated_usd_nano=usd)


class _PoolMember:
    def __init__(self, member_id: str, base_url: str) -> None:
        self.id = member_id
        self.base_url = base_url


def _isolate_env(
    monkeypatch: pytest.MonkeyPatch,
    *,
    api_key: str = "",
    base_url: str = "https://api.deepseek.com",
    credential_id: str = "",
    model_credentials: str = "",
) -> None:
    monkeypatch.setattr(settings, "platform_api_key", api_key)
    monkeypatch.setattr(settings, "platform_base_url", base_url)
    monkeypatch.setattr(settings, "platform_credential_id", credential_id)
    monkeypatch.setattr(settings, "platform_model_credentials", model_credentials)


def test_go_window_credential_ids_excludes_zen_exact_match_only(monkeypatch):
    _isolate_env(monkeypatch)
    zen = _PoolMember("zen-1", _ZEN)
    go = _PoolMember("go-1", _GO)
    go_slash = _PoolMember("go-2", f"{_GO}/")
    other = _PoolMember("ds-1", "https://api.deepseek.com")
    assert go_window_credential_ids([zen, go, go_slash, other]) == frozenset({"go-1", "go-2"})
    assert go_window_credential_ids([zen]) == frozenset()
    assert go_window_credential_ids([]) == frozenset()


def test_go_window_credential_ids_includes_env_go_hash(monkeypatch):
    _isolate_env(monkeypatch, api_key="sk-env-go", base_url=_GO)
    expected = derive_platform_credential_id("sk-env-go", _GO)
    assert expected.startswith("pk_")
    assert go_window_credential_ids([]) == frozenset({expected})
    _isolate_env(
        monkeypatch, api_key="sk-env-go", base_url=_GO, credential_id="env-go-alias"
    )
    assert go_window_credential_ids([]) == frozenset({"env-go-alias"})
    # Pool member sharing the env alias must not duplicate.
    assert go_window_credential_ids([_PoolMember("env-go-alias", _GO)]) == frozenset(
        {"env-go-alias"}
    )


def test_go_window_credential_ids_excludes_env_zen(monkeypatch):
    _isolate_env(
        monkeypatch, api_key="sk-env-zen", base_url=_ZEN, credential_id="zen-alias"
    )
    assert go_window_credential_ids([]) == frozenset()
    assert go_window_credential_ids([_PoolMember("go-1", _GO)]) == frozenset({"go-1"})


def test_go_window_credential_ids_includes_model_override_go(monkeypatch):
    _isolate_env(
        monkeypatch,
        api_key="sk-default",
        base_url=_ZEN,
        credential_id="env-zen",
        model_credentials=json.dumps(
            {"relay-b": {"api_key": "sk-relay-b", "base_url": _GO, "id": "go-2"}}
        ),
    )
    assert go_window_credential_ids([]) == frozenset({"go-2"})
    _isolate_env(
        monkeypatch,
        api_key="sk-default",
        base_url=_ZEN,
        model_credentials=json.dumps(
            {"relay-b": {"api_key": "sk-relay-b", "base_url": _GO}}
        ),
    )
    expected = derive_platform_credential_id("sk-relay-b", _GO)
    assert expected.startswith("pk_")
    assert go_window_credential_ids([]) == frozenset({expected})


def test_utc_week_bounds_start_monday():
    # Tuesday 12:00 UTC → week started Monday 00:00, resets next Monday.
    start, reset = utc_week_bounds(_T0)
    assert start == datetime(2026, 8, 17, 0, 0, tzinfo=UTC)
    assert reset == datetime(2026, 8, 24, 0, 0, tzinfo=UTC)


def test_utc_week_bounds_monday_midnight_is_new_week():
    monday = datetime(2026, 8, 17, 0, 0, tzinfo=UTC)
    start, reset = utc_week_bounds(monday)
    assert start == monday
    assert reset == datetime(2026, 8, 24, 0, 0, tzinfo=UTC)


def test_utc_week_bounds_sunday_still_previous_monday():
    sunday = datetime(2026, 8, 16, 23, 0, tzinfo=UTC)
    start, reset = utc_week_bounds(sunday)
    assert start == datetime(2026, 8, 10, 0, 0, tzinfo=UTC)
    assert reset == datetime(2026, 8, 17, 0, 0, tzinfo=UTC)


def test_subscription_month_after_anniversary():
    # Day 15, today Aug 18 → [Aug 15, Sep 15).
    start, reset = subscription_month_bounds(_T0, 15)
    assert start == datetime(2026, 8, 15, 0, 0, tzinfo=UTC)
    assert reset == datetime(2026, 9, 15, 0, 0, tzinfo=UTC)


def test_subscription_month_before_anniversary():
    now = datetime(2026, 8, 10, 8, 0, tzinfo=UTC)
    start, reset = subscription_month_bounds(now, 15)
    assert start == datetime(2026, 7, 15, 0, 0, tzinfo=UTC)
    assert reset == datetime(2026, 8, 15, 0, 0, tzinfo=UTC)


def test_subscription_month_day_31_clamps_in_february():
    now = datetime(2026, 3, 5, 0, 0, tzinfo=UTC)
    start, reset = subscription_month_bounds(now, 31)
    assert start == datetime(2026, 2, 28, 0, 0, tzinfo=UTC)
    assert reset == datetime(2026, 3, 31, 0, 0, tzinfo=UTC)


def test_subscription_month_rejects_out_of_range_day():
    with pytest.raises(ValueError, match="1-31"):
        subscription_month_bounds(_T0, 0)


def test_platform_settings_subscription_day_bounds():
    assert PlatformSettings().platform_go_subscription_day == 1
    assert PlatformSettings(platform_go_subscription_day=31).platform_go_subscription_day == 31
    with pytest.raises(ValidationError):
        PlatformSettings(platform_go_subscription_day=0)
    with pytest.raises(ValidationError):
        PlatformSettings(platform_go_subscription_day=32)


def test_five_hour_empty():
    snap = five_hour_window([], _T0)
    assert snap.cost_total_nano == 0
    assert snap.estimated_usd_nano == 0
    assert snap.calls == 0
    assert snap.started_at is None
    assert snap.reset_at is None


def test_five_hour_single_active_call():
    start = _T0 - timedelta(hours=1)
    snap = five_hour_window([_s(start, 1000, 77)], _T0)
    assert snap.cost_total_nano == 1000
    assert snap.estimated_usd_nano == 77
    assert snap.calls == 1
    assert snap.started_at == start
    assert snap.reset_at == start + FIVE_HOURS


def test_five_hour_same_window_accumulates():
    a = _T0 - timedelta(hours=2)
    b = _T0 - timedelta(hours=1)
    snap = five_hour_window([_s(a, 100, 10), _s(b, 50, 5)], _T0)
    assert snap.cost_total_nano == 150
    assert snap.estimated_usd_nano == 15
    assert snap.calls == 2
    assert snap.started_at == a
    assert snap.reset_at == a + FIVE_HOURS


def test_five_hour_call_at_boundary_opens_new_window():
    start = _T0 - timedelta(hours=2)
    boundary = start + FIVE_HOURS
    now = boundary + timedelta(minutes=10)
    snap = five_hour_window([_s(start, 900, 90), _s(boundary, 40, 4)], now)
    assert snap.cost_total_nano == 40
    assert snap.estimated_usd_nano == 4
    assert snap.calls == 1
    assert snap.started_at == boundary
    assert snap.reset_at == boundary + FIVE_HOURS


def test_five_hour_idle_past_end_zeros():
    start = _T0 - timedelta(hours=6)
    snap = five_hour_window([_s(start, 5000, 50)], _T0)
    assert snap.cost_total_nano == 0
    assert snap.estimated_usd_nano == 0
    assert snap.calls == 0
    assert snap.started_at is None
    assert snap.reset_at == start + FIVE_HOURS


def test_five_hour_not_sliding_sum():
    """A tail from an expired window must not join the current 5h cumulative.

    Sliding ``now-5h`` would include the 10:00 call; fixed-window must not.
    """
    now = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
    old_start = datetime(2026, 8, 18, 6, 0, tzinfo=UTC)  # window [06:00, 11:00)
    old_tail = datetime(2026, 8, 18, 10, 0, tzinfo=UTC)
    new_start = datetime(2026, 8, 18, 11, 30, tzinfo=UTC)
    snap = five_hour_window(
        [_s(old_start, 800, 80), _s(old_tail, 200, 20), _s(new_start, 50, 5)],
        now,
    )
    assert snap.cost_total_nano == 50
    assert snap.estimated_usd_nano == 5
    assert snap.calls == 1
    assert snap.started_at == new_start
    assert snap.reset_at == new_start + FIVE_HOURS


def test_aggregate_go_windows_splits_week_and_month():
    now = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
    # Before this subscription month (anniversary day 15).
    last_month = datetime(2026, 8, 14, 10, 0, tzinfo=UTC)
    # Previous UTC week, but still inside this subscription month.
    last_week = datetime(2026, 8, 16, 10, 0, tzinfo=UTC)
    # After subscription day 15, inside this week.
    this_week = datetime(2026, 8, 17, 8, 0, tzinfo=UTC)
    rows = [_s(last_month, 5000, 50), _s(last_week, 1000, 10), _s(this_week, 200, 2)]
    out = aggregate_go_windows(rows, now=now, subscription_day=15)
    assert out["weekly"].cost_total_nano == 200
    assert out["weekly"].estimated_usd_nano == 2
    assert out["weekly"].calls == 1
    assert out["weekly"].started_at == datetime(2026, 8, 17, 0, 0, tzinfo=UTC)
    assert out["monthly"].cost_total_nano == 1200
    assert out["monthly"].estimated_usd_nano == 12
    assert out["monthly"].calls == 2
    assert out["monthly"].started_at == datetime(2026, 8, 15, 0, 0, tzinfo=UTC)
    # Oldest window started 8/14 10:00 and ended 15:00; subsequent calls each
    # open their own 5h window and those have also expired by 8/18 12:00.
    assert out["five_hour"].cost_total_nano == 0
    assert out["five_hour"].estimated_usd_nano == 0


def test_aggregate_sums_per_call_usd_not_a_blended_rate():
    """Peak and Off-Peak lines keep their own estimate; the window just adds them."""
    now = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
    peak = datetime(2026, 8, 18, 2, 0, tzinfo=UTC)
    off = datetime(2026, 8, 18, 11, 0, tzinfo=UTC)
    out = aggregate_go_windows(
        [_s(peak, 1, 440), _s(off, 1, 220)],
        now=now,
        subscription_day=1,
    )
    assert out["weekly"].estimated_usd_nano == 660
    assert out["monthly"].estimated_usd_nano == 660
