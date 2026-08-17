"""Platform-wide usage board (全站用量看板)."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.cost_view import cost_breakdown, estimated_cost_breakdown, usage_breakdown
from agentcore.api.dependencies import AdminUser, get_cost_event_repo, get_db
from agentcore.api.routes.admin._shared import _TREND_DAYS
from agentcore.api.schemas import (
    AdminGoCredentialWindows,
    AdminGoWindow,
    AdminGoWindows,
    AdminUsageSummary,
    AdminUserCostLine,
    DailyCost,
    ModelCostLine,
    UsageWindow,
)
from agentcore.billing.go_windows import (
    CallSpend,
    GoWindowSnapshot,
    aggregate_go_windows,
    call_spend_from_ledger,
    go_window_credential_ids,
)
from agentcore.billing.opencode_go_public_prices import (
    MODEL_ID,
    PRICE_AS_OF,
)
from agentcore.config import settings
from agentcore.db.models import PlatformCredential
from agentcore.db.repositories import CostEventRepository
from agentcore.db.repositories.platform_credentials import PlatformCredentialRepository

router = APIRouter(tags=["admin"])

# 全站看板 Top-N spenders shown in the by-user payroll (the long tail isn't
# actionable for ops).
_TOP_USERS = 20


@router.get("/usage/summary", response_model=AdminUsageSummary)
async def usage_summary(
    admin: AdminUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> AdminUsageSummary:
    """全站用量看板: platform-wide today / month totals, the Top spenders by user
    (工资单 by user), and the 7-day platform trend.

    The cross-user counterpart of ``GET /v1/usage/summary`` — same windows (bounded
    at the current UTC day / month start, MVP), but aggregated over *every* account
    instead of scoped to the caller. ``billing_mode`` lets the client frame cost
    honestly: in "byok" these totals are the sum of each user's spend on their own
    DeepSeek key (not platform-paid).
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)

    today = await repo.aggregate_for_window(since=day_start)
    month = await repo.aggregate_for_window(since=month_start)
    month_by_user = await repo.aggregate_by_user_for_window(since=month_start, limit=_TOP_USERS)
    month_by_model = await repo.aggregate_by_model_for_window(since=month_start)

    # 近 7 日趋势: zero-fill the daily map into a fixed, oldest-first series ending
    # today so the sparkline is a stable length even for sparse spend.
    trend_start = day_start - timedelta(days=_TREND_DAYS - 1)
    daily = await repo.aggregate_daily_for_window(since=trend_start)
    recent_daily_cost = []
    for i in range(_TREND_DAYS):
        iso = (trend_start + timedelta(days=i)).date().isoformat()
        recent_daily_cost.append(DailyCost(date=iso, cost_total=daily.get(iso, 0)))

    return AdminUsageSummary(
        today=UsageWindow(
            usage=usage_breakdown(today["usage"]),
            cost=cost_breakdown(today["cost"]),
            estimated_cost=estimated_cost_breakdown(cost=today.get("estimated_cost") or {}),
            requests=today["turns"],
        ),
        month=UsageWindow(
            usage=usage_breakdown(month["usage"]),
            cost=cost_breakdown(month["cost"]),
            estimated_cost=estimated_cost_breakdown(cost=month.get("estimated_cost") or {}),
            requests=month["turns"],
        ),
        month_by_user=[
            AdminUserCostLine(
                user_id=row["user_id"],
                username=row["username"],
                display_name=row["display_name"],
                cost_total=int(row["cost_total"]),
                turns=int(row["turns"]),
            )
            for row in month_by_user
        ],
        month_by_model=[
            ModelCostLine(
                model=row["model"],
                calls=int(row["calls"]),
                tokens_total=int(row["tokens_total"]),
                cost_total=int(row["cost_total"]),
                cost_estimated_total=int(row.get("cost_estimated_total", 0) or 0),
            )
            for row in month_by_model
        ],
        recent_daily_cost=recent_daily_cost,
        billing_mode=settings.billing_mode,
    )


def _go_window(snap: GoWindowSnapshot) -> AdminGoWindow:
    return AdminGoWindow(
        cost_total_nano=snap.cost_total_nano,
        estimated_usd_nano=snap.estimated_usd_nano,
        calls=snap.calls,
        started_at=snap.started_at,
        reset_at=snap.reset_at,
    )


@router.get("/usage/go-windows", response_model=AdminGoWindows)
async def go_windows(
    admin: AdminUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
    db: AsyncSession = Depends(get_db),
) -> AdminGoWindows:
    """OpenCode Go 5h / week / month windows from Go-endpoint ledger rows.

    Two columns: curated nominal nano-CNY, plus a read-time public-list USD
    estimate. Neither is an upstream bill. Pool members and env / per-model
    overrides whose bound endpoint exact-matches the Go preset count; Zen /
    untagged pre-pool / BYOK / vendor extras stay out. Top-level monthly uses
    the env ``PLATFORM_GO_SUBSCRIPTION_DAY``. Go pool members are repeated in
    ``members`` with each account's own subscription day.
    """
    now = datetime.now(UTC)
    pool_rows = await PlatformCredentialRepository(db).list_all()
    go_ids = go_window_credential_ids(pool_rows)
    tagged = await repo.list_platform_prepaid_call_spend_tagged(
        platform_credential_ids=go_ids
    )
    rows = [
        call_spend_from_ledger(ts, amount, tokens, model)
        for ts, amount, _cid, tokens, model in tagged
    ]
    windows = aggregate_go_windows(
        rows,
        now=now,
        subscription_day=settings.platform_go_subscription_day,
    )
    members = _go_windows_by_member(pool_rows, tagged, go_ids=go_ids, now=now)
    return AdminGoWindows(
        five_hour=_go_window(windows["five_hour"]),
        weekly=_go_window(windows["weekly"]),
        monthly=_go_window(windows["monthly"]),
        subscription_day=settings.platform_go_subscription_day,
        cost_basis="nominal_nano_cny",
        estimate_basis="opencode_public_list",
        estimate_currency="USD",
        estimate_price_as_of=PRICE_AS_OF,
        estimate_model=MODEL_ID,
        as_of=now,
        members=members,
    )


def _go_windows_by_member(
    pool_rows: Sequence[PlatformCredential],
    tagged: list[tuple[datetime, int, str | None, dict, str]],
    *,
    go_ids: frozenset[str],
    now: datetime,
) -> list[AdminGoCredentialWindows]:
    go_rows = [row for row in pool_rows if row.id in go_ids]
    if not go_rows:
        return []
    by_id: dict[str, list[CallSpend]] = {}
    for ts, amount, cid, tokens, model in tagged:
        if not cid:
            continue
        by_id.setdefault(cid, []).append(call_spend_from_ledger(ts, amount, tokens, model))
    out: list[AdminGoCredentialWindows] = []
    for row in go_rows:
        member_windows = aggregate_go_windows(
            by_id.get(row.id, []),
            now=now,
            subscription_day=int(row.subscription_day),
        )
        out.append(
            AdminGoCredentialWindows(
                platform_credential_id=row.id,
                label=row.label or "",
                enabled=bool(row.enabled),
                subscription_day=int(row.subscription_day),
                five_hour=_go_window(member_windows["five_hour"]),
                weekly=_go_window(member_windows["weekly"]),
                monthly=_go_window(member_windows["monthly"]),
            )
        )
    return out
