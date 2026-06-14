"""Quota enforcement — the「总量」防线 that refuses a new turn once a user has
exhausted a configured usage window (成本配额与计费.md §一).

Three independent dimensions, each with its own rolling window:

| 维度          | 窗口         | 阈值 (config)               |
|---------------|--------------|-----------------------------|
| 日 token      | 当日 0 点起  | ``quota_daily_tokens``      |
| 月成本 (USD)  | 当月 1 号起  | ``quota_monthly_cost_usd``  |
| 日请求数      | 当日 0 点起  | ``quota_daily_requests``    |

A ``0`` threshold means that dimension is unlimited (fail-safe 宽松默认); when
*every* dimension is unlimited the check skips the DB read entirely. The check is
turn-granular and runs **before** a turn starts — an exhausted account is refused
its *next* turn rather than having an in-flight reply cut off (不腰斩进行中回合).
Spend is read from the ``cost_events`` ledger (the money truth source, 不变量
#1), so the limit reflects 真实记账 rather than an estimate.

Per-user overrides / admin ``is_unlimited`` (决策④) are a later refinement; today
the thresholds are the global config values.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from agentcore.config import settings
from agentcore.core.errors import QuotaExceededError
from agentcore.db.repositories import CostEventRepository
from agentcore.llm.pricing import NANO_PER_USD, nano_usd_to_cny


@dataclass(frozen=True)
class QuotaLimits:
    """Resolved quota thresholds (``0`` = that dimension is unlimited).

    ``monthly_cost_nano`` is pre-converted from the USD config to the ledger's
    integer nano-USD unit so the comparison stays in one currency口径 (决策①).
    """

    daily_tokens: int
    monthly_cost_nano: int
    daily_requests: int

    @classmethod
    def from_settings(cls) -> QuotaLimits:
        return cls(
            daily_tokens=settings.quota_daily_tokens,
            monthly_cost_nano=int(settings.quota_monthly_cost_usd * NANO_PER_USD),
            daily_requests=settings.quota_daily_requests,
        )

    @property
    def all_unlimited(self) -> bool:
        return (
            self.daily_tokens <= 0
            and self.monthly_cost_nano <= 0
            and self.daily_requests <= 0
        )


async def enforce_quota(
    repo: CostEventRepository,
    user_id: str,
    *,
    now: datetime | None = None,
    limits: QuotaLimits | None = None,
) -> None:
    """Raise :class:`QuotaExceededError` if ``user_id`` has hit any quota.

    No-op (and no DB read) when every dimension is unlimited. Otherwise sums the
    user's ledger over the day window (daily tokens + requests); only if those
    pass *and* a monthly cap is configured does it read the month window (monthly
    cost). That is 1–2 indexed aggregates on ``ix_cost_events_user_created`` —
    light enough for the turn hot path.
    """
    limits = limits or QuotaLimits.from_settings()
    if limits.all_unlimited:
        return

    now = now or datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    today = await repo.aggregate_for_window(user_id=user_id, since=day_start)

    if limits.daily_tokens > 0:
        # Canonical "total tokens" = input + output (output already includes
        # reasoning), matching TokenUsage.total_tokens.
        used = int(today["usage"]["input"]) + int(today["usage"]["output"])
        if used >= limits.daily_tokens:
            raise QuotaExceededError(
                f"已达每日 token 上限（{used:,} / {limits.daily_tokens:,}），"
                "明日 0 点（UTC）重置。",
                dimension="daily_tokens",
                used=used,
                limit=limits.daily_tokens,
            )

    if limits.daily_requests > 0:
        # 一回合 = 一个 assistant message_id（与对话累计 / 仪表盘的「请求」口径一致）。
        used = int(today["turns"])
        if used >= limits.daily_requests:
            raise QuotaExceededError(
                f"已达每日请求上限（{used} / {limits.daily_requests}），"
                "明日 0 点（UTC）重置。",
                dimension="daily_requests",
                used=used,
                limit=limits.daily_requests,
            )

    if limits.monthly_cost_nano > 0:
        month_start = day_start.replace(day=1)
        month = await repo.aggregate_for_window(user_id=user_id, since=month_start)
        used = int(month["cost"]["total"])
        if used >= limits.monthly_cost_nano:
            spent_cny = nano_usd_to_cny(used, settings.cny_per_usd)
            cap_cny = nano_usd_to_cny(limits.monthly_cost_nano, settings.cny_per_usd)
            raise QuotaExceededError(
                f"已达本月成本上限（约 ¥{spent_cny:.2f} / ¥{cap_cny:.2f}），"
                "下月 1 号重置。",
                dimension="monthly_cost",
                used=used,
                limit=limits.monthly_cost_nano,
            )
