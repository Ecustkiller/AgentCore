"""OpenCode Go window aggregation from our ledger (read-side).

Go settles its 5h / weekly / monthly caps in **upstream USD**. ``cost_calls``
stores curated nominal nano-CNY **and** the token split. This module sums two
independent columns:

* ``cost_total_nano`` — curated nominal nano-CNY (unchanged; calibration vs 429).
* ``estimated_usd_nano`` — read-time public-list USD (see
  ``opencode_go_public_prices``). Not a balance, not an FX of the nominal
  column, not written back.

Window semantics match Go's observed behaviour (not our user-facing UTC day /
calendar-month quotas):

* **Weekly** — UTC Monday 00:00 → next Monday 00:00.
* **Monthly** — anniversary of ``subscription_day`` (clamped to the month's last
  day); not a calendar month unless that day happens to be 1.
* **5 hour** — fixed window starting at the first platform call after the
  previous window ended; resets at ``started_at + 5h``. Idle past that end
  zeros the counter. **Not** a sliding ``now - 5h`` sum.

Only rows that **provably** hit a Go endpoint belong here. Proof is
``cost_calls.platform_credential_id`` joining an id whose bound endpoint
exact-matches the OpenCode Go preset (``is_opencode_go_base_url`` — never a
prefix/contains check against ``/zen/v1``). Sources: pool members (persisted
``base_url``) and the env / ``PLATFORM_MODEL_CREDENTIALS`` pairs that resolve
through ``derive_platform_credential_id`` (same function as the write side).
``credential_source=platform`` alone means「平台付的钱」, not「走了 Go」.
Untagged pre-pool rows, Zen endpoints, and BYOK / vendor extras stay out.

When the pool has Go members, the admin endpoint groups by
``platform_credential_id`` and uses each row's ``subscription_day``. The
top-level aggregate still uses the env anniversary (empty-pool fallback).
"""

from __future__ import annotations

import calendar
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from agentcore.billing.opencode_go_public_prices import estimate_go_public_usd_nano
from agentcore.config import settings
from agentcore.config.platform import parse_platform_model_credentials
from agentcore.llm.byok_provider_presets import is_opencode_go_base_url
from agentcore.llm.credentials import derive_platform_credential_id

FIVE_HOURS = timedelta(hours=5)
WEEK = timedelta(days=7)


@dataclass(frozen=True)
class CallSpend:
    """One platform-prepaid call: nominal CNY + read-time public-list USD."""

    created_at: datetime
    cost_total_nano: int
    estimated_usd_nano: int = 0


@dataclass(frozen=True)
class GoWindowSnapshot:
    """Current cumulative for one Go-style window.

    ``cost_total_nano`` is curated nominal nano-CNY. ``estimated_usd_nano`` is
    the public-list estimate (nano-USD) for the same rows — never a balance.
    """

    cost_total_nano: int
    calls: int
    started_at: datetime | None
    reset_at: datetime | None
    estimated_usd_nano: int = 0


def as_utc(ts: datetime) -> datetime:
    """Normalise a timestamp to UTC (naive values are treated as UTC)."""
    if ts.tzinfo is None:
        return ts.replace(tzinfo=UTC)
    return ts.astimezone(UTC)


def go_window_credential_ids(members: Sequence[Any]) -> frozenset[str]:
    """Ids whose bound endpoint is OpenCode Go (exact preset match).

    Pool members contribute their persisted ``id`` when ``base_url`` matches.
    Env default and ``PLATFORM_MODEL_CREDENTIALS`` overrides contribute the
    same derived id the write side stamps (``derive_platform_credential_id``),
    including ``PLATFORM_CREDENTIAL_ID`` / per-model ``id`` aliases. Same id
    from pool and env is kept once.
    """
    ids: set[str] = set()
    for row in members:
        cid = str(getattr(row, "id", "") or "").strip()
        url = str(getattr(row, "base_url", "") or "")
        if cid and is_opencode_go_base_url(url):
            ids.add(cid)
    ids.update(_env_go_window_credential_ids())
    return frozenset(ids)


def _env_go_window_credential_ids() -> set[str]:
    """Derived ids for env / per-model pairs that exact-match the Go preset."""
    default_key = settings.platform_api_key.strip()
    default_url = (settings.platform_base_url or "").strip()
    pairs: set[tuple[str, str]] = set()
    if default_key:
        pairs.add((default_key, default_url))
    for entry in parse_platform_model_credentials(settings.platform_model_credentials).values():
        key = (entry.get("api_key") or "").strip() or default_key
        url = (entry.get("base_url") or "").strip() or default_url
        if key:
            pairs.add((key, url))
    ids: set[str] = set()
    for key, url in pairs:
        if not is_opencode_go_base_url(url):
            continue
        cid = derive_platform_credential_id(key, url).strip()
        if cid:
            ids.add(cid)
    return ids


def call_spend_from_ledger(
    created_at: datetime,
    cost_total_nano: int,
    tokens: Mapping[str, Any] | None,
    model: str = "",
) -> CallSpend:
    """Attach a read-time public-list USD estimate to one ledger line.

    ``model`` gates the Flash public list — other catalog ids stay at $0.
    """
    return CallSpend(
        created_at=created_at,
        cost_total_nano=int(cost_total_nano),
        estimated_usd_nano=estimate_go_public_usd_nano(tokens, created_at, model=model),
    )


def utc_week_bounds(now: datetime) -> tuple[datetime, datetime]:
    """``[Monday 00:00 UTC, next Monday 00:00 UTC)`` containing ``now``."""
    now = as_utc(now)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(
        days=now.weekday()
    )
    return start, start + WEEK


def subscription_month_bounds(now: datetime, subscription_day: int) -> tuple[datetime, datetime]:
    """``[last anniversary, next anniversary)`` in UTC for ``subscription_day``.

    Day 31 in a short month clamps to that month's last day (billing-anniversary
    convention). ``subscription_day`` must be 1–31.
    """
    if not 1 <= subscription_day <= 31:
        raise ValueError(f"subscription_day must be 1-31, got {subscription_day}")
    now = as_utc(now)
    this = _anniversary(now.year, now.month, subscription_day)
    if now >= this:
        start = this
        if now.month == 12:
            end = _anniversary(now.year + 1, 1, subscription_day)
        else:
            end = _anniversary(now.year, now.month + 1, subscription_day)
    else:
        end = this
        if now.month == 1:
            start = _anniversary(now.year - 1, 12, subscription_day)
        else:
            start = _anniversary(now.year, now.month - 1, subscription_day)
    return start, end


def five_hour_window(rows: Sequence[CallSpend], now: datetime) -> GoWindowSnapshot:
    """Walk fixed 5h windows from the first row; return the window containing ``now``.

    ``rows`` must be the complete platform-prepaid series (or a prefix that
    starts on a window origin — the first call after a ≥5h gap / the first
    call ever), sorted by ``created_at`` ascending.

    A call at exactly ``started_at + 5h`` opens the next window (half-open).
    If the last reconstructed window has already ended and no later call
    opened a new one, cumulative is 0 and ``reset_at`` is that past end.
    """
    now = as_utc(now)
    if not rows:
        return GoWindowSnapshot(0, 0, None, None, 0)

    window_start = as_utc(rows[0].created_at)
    cost = 0
    usd = 0
    calls = 0
    for row in rows:
        ts = as_utc(row.created_at)
        if ts >= window_start + FIVE_HOURS:
            window_start = ts
            cost = int(row.cost_total_nano)
            usd = int(row.estimated_usd_nano)
            calls = 1
        else:
            cost += int(row.cost_total_nano)
            usd += int(row.estimated_usd_nano)
            calls += 1

    reset_at = window_start + FIVE_HOURS
    if now >= reset_at:
        return GoWindowSnapshot(0, 0, None, reset_at, 0)
    return GoWindowSnapshot(cost, calls, window_start, reset_at, usd)


def sum_since(rows: Sequence[CallSpend], since: datetime) -> tuple[int, int, int]:
    """``(cost_total_nano, estimated_usd_nano, calls)`` for ``created_at >= since``."""
    since = as_utc(since)
    cost = 0
    usd = 0
    calls = 0
    for row in rows:
        if as_utc(row.created_at) >= since:
            cost += int(row.cost_total_nano)
            usd += int(row.estimated_usd_nano)
            calls += 1
    return cost, usd, calls


def aggregate_go_windows(
    rows: Sequence[CallSpend],
    *,
    now: datetime,
    subscription_day: int,
) -> dict[str, GoWindowSnapshot]:
    """Build the three current Go windows from a platform-prepaid spend series."""
    now = as_utc(now)
    week_start, week_reset = utc_week_bounds(now)
    month_start, month_reset = subscription_month_bounds(now, subscription_day)
    week_cost, week_usd, week_calls = sum_since(rows, week_start)
    month_cost, month_usd, month_calls = sum_since(rows, month_start)
    return {
        "five_hour": five_hour_window(rows, now),
        "weekly": GoWindowSnapshot(week_cost, week_calls, week_start, week_reset, week_usd),
        "monthly": GoWindowSnapshot(month_cost, month_calls, month_start, month_reset, month_usd),
    }


def _anniversary(year: int, month: int, day: int) -> datetime:
    last = calendar.monthrange(year, month)[1]
    return datetime(year, month, min(day, last), tzinfo=UTC)
