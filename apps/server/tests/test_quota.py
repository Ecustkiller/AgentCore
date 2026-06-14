"""Unit tests for quota enforcement (成本配额与计费.md §一).

The fake repo stands in for ``CostEventRepository``: ``enforce_quota`` only needs
``aggregate_for_window``. ``_NOW`` is mid-month so the day window (15th 00:00) and
month window (1st 00:00) have distinct ``since.day`` values, letting the fake tell
them apart and letting us assert *which* window was queried.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import QuotaExceededError
from agentcore.llm.pricing import NANO_PER_USD

_NOW = datetime(2026, 6, 15, 12, 0, tzinfo=UTC)


def _agg(*, input_: int = 0, output: int = 0, turns: int = 0, cost_total: int = 0) -> dict:
    return {
        "usage": {
            "input": input_,
            "output": output,
            "reasoning": 0,
            "cache_hit": 0,
            "cache_miss": 0,
        },
        "cost": {"input": 0, "cached": 0, "output": 0, "total": cost_total},
        "rounds": 0,
        "turns": turns,
    }


class _FakeRepo:
    """Returns the month rollup for the month-start window, else the day rollup."""

    def __init__(self, *, today: dict | None = None, month: dict | None = None):
        self._today = today or _agg()
        self._month = month or _agg()
        self.windows: list[datetime] = []

    async def aggregate_for_window(self, *, user_id: str, since: datetime) -> dict:
        self.windows.append(since)
        return self._month if since.day == 1 else self._today


async def test_all_unlimited_skips_db():
    repo = _FakeRepo(today=_agg(input_=10**9, output=10**9, turns=10**6))
    await enforce_quota(repo, "u1", now=_NOW, limits=QuotaLimits(0, 0, 0))
    assert repo.windows == []  # no DB read when every dimension is unlimited


async def test_under_all_limits_passes():
    repo = _FakeRepo(
        today=_agg(input_=400, output=100, turns=5),
        month=_agg(cost_total=NANO_PER_USD),  # $1 of $5
    )
    limits = QuotaLimits(
        daily_tokens=1000, monthly_cost_nano=5 * NANO_PER_USD, daily_requests=10
    )
    await enforce_quota(repo, "u1", now=_NOW, limits=limits)


async def test_daily_tokens_exceeded():
    repo = _FakeRepo(today=_agg(input_=600, output=500, turns=1))  # 1100 > 1000
    limits = QuotaLimits(daily_tokens=1000, monthly_cost_nano=0, daily_requests=0)
    with pytest.raises(QuotaExceededError) as ei:
        await enforce_quota(repo, "u1", now=_NOW, limits=limits)
    assert ei.value.dimension == "daily_tokens"
    assert ei.value.status_code == 429
    assert ei.value.used == 1100


async def test_daily_requests_exceeded():
    repo = _FakeRepo(today=_agg(input_=1, output=1, turns=200))
    limits = QuotaLimits(daily_tokens=0, monthly_cost_nano=0, daily_requests=200)
    with pytest.raises(QuotaExceededError) as ei:
        await enforce_quota(repo, "u1", now=_NOW, limits=limits)
    assert ei.value.dimension == "daily_requests"


async def test_monthly_cost_exceeded():
    repo = _FakeRepo(
        today=_agg(input_=1, output=1, turns=1),
        month=_agg(cost_total=6 * NANO_PER_USD),  # $6 > $5
    )
    limits = QuotaLimits(daily_tokens=0, monthly_cost_nano=5 * NANO_PER_USD, daily_requests=0)
    with pytest.raises(QuotaExceededError) as ei:
        await enforce_quota(repo, "u1", now=_NOW, limits=limits)
    assert ei.value.dimension == "monthly_cost"


async def test_zero_dimension_is_unlimited():
    # Huge token use, but daily_tokens=0 (unlimited); only requests is capped, and under.
    repo = _FakeRepo(today=_agg(input_=10**9, output=10**9, turns=1))
    limits = QuotaLimits(daily_tokens=0, monthly_cost_nano=0, daily_requests=10)
    await enforce_quota(repo, "u1", now=_NOW, limits=limits)


async def test_at_limit_counts_as_exceeded():
    # Boundary: used == limit is refused (>= comparison).
    repo = _FakeRepo(today=_agg(input_=1000, output=0, turns=0))
    limits = QuotaLimits(daily_tokens=1000, monthly_cost_nano=0, daily_requests=0)
    with pytest.raises(QuotaExceededError):
        await enforce_quota(repo, "u1", now=_NOW, limits=limits)


async def test_month_window_not_queried_when_daily_fails():
    # Daily tokens already blown → the month window must never be read.
    repo = _FakeRepo(today=_agg(input_=2000, output=0, turns=1))
    limits = QuotaLimits(
        daily_tokens=1000, monthly_cost_nano=5 * NANO_PER_USD, daily_requests=0
    )
    with pytest.raises(QuotaExceededError):
        await enforce_quota(repo, "u1", now=_NOW, limits=limits)
    assert all(since.day != 1 for since in repo.windows)


def test_all_unlimited_property():
    assert QuotaLimits(0, 0, 0).all_unlimited
    assert not QuotaLimits(1, 0, 0).all_unlimited
    assert not QuotaLimits(0, 1, 0).all_unlimited
    assert not QuotaLimits(0, 0, 1).all_unlimited


def test_from_settings_converts_monthly_to_nano():
    from agentcore.config import settings

    limits = QuotaLimits.from_settings()
    assert limits.daily_tokens == settings.quota_daily_tokens
    assert limits.daily_requests == settings.quota_daily_requests
    assert limits.monthly_cost_nano == int(settings.quota_monthly_cost_usd * NANO_PER_USD)
