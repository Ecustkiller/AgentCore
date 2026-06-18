"""Cost & usage observability endpoints (团队工资单 + 对话累计 + 账户仪表盘).

成本是产品差异点：AgentCore 是 multi-agent，花销天然能按 Agent/角色拆开，所以这些
读接口呈现的是「团队工资单」而非单一总额。

All three reads are scoped to the authenticated user via ``cost_events.user_id``,
so a non-owner can never read another user's spend (IDOR-safe) — the message /
conversation endpoints additionally 404 or return empty rather than leaking
existence. The ledger (``cost_events``) is the truth source for real money spent
(不变量 #1); ``Message.usage`` is only a display snapshot.
"""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends

from agentcore.api.cost_view import cost_breakdown, usage_breakdown
from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_cost_event_repo,
)
from agentcore.api.schemas import (
    AgentCostLine,
    ConversationCost,
    DailyCost,
    QuotaStatus,
    RoleCostLine,
    TurnCost,
    UsageSummary,
    UsageWindow,
)
from agentcore.config import settings
from agentcore.core.errors import NotFoundError
from agentcore.db.models import CostEvent
from agentcore.db.repositories import ConversationRepository, CostEventRepository
from agentcore.llm.pricing import NANO_PER_USD

router = APIRouter(tags=["usage"])

# Account dashboard trend window: the last N UTC days (incl today) shown as a
# spend sparkline (§7.3D). Fixed length so the series is zero-filled and stable.
_TREND_DAYS = 7


def _sum_rows(rows: list[CostEvent]) -> tuple[dict, dict, int]:
    """Roll up a turn's payroll rows into (usage, cost, rounds) totals.

    Summed in Python from the rows already fetched for the payroll (no second
    query). The turn total is the SUM of the per-run prices (workers may differ
    in model tier, so the rows are never re-priced).
    """
    usage = {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0}
    cost = {"input": 0, "cached": 0, "output": 0, "total": 0}
    rounds = 0
    for row in rows:
        for key in usage:
            usage[key] += int((row.tokens or {}).get(key, 0))
        row_cost = row.cost or {}
        for key in ("input", "cached", "output"):
            cost[key] += int(row_cost.get(key, 0))
        cost["total"] += int(row.cost_total_nano or 0)
        rounds += int(row.rounds or 0)
    return usage, cost, rounds


@router.get("/messages/{message_id}/cost", response_model=TurnCost)
async def get_message_cost(
    message_id: str,
    user: AuthUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> TurnCost:
    """The team payroll for one assistant turn (per-Agent cost + the turn total).

    Rebuilt from the ledger by ``message_id`` (scoped to the caller), so a past
    turn's payroll replays on reload. An unknown / non-owned message yields zeros
    + an empty roster rather than 404 — it never leaks whether the id exists.
    """
    rows = list(await repo.list_for_message(message_id, user_id=user.user_id))
    agents = [
        AgentCostLine(
            run_id=row.run_id,
            agent_id=row.agent_id,
            role=row.role,
            model=row.model,
            usage=usage_breakdown(row.tokens or {}),
            cost=cost_breakdown(row.cost or {}),
            duration_ms=int(row.duration_ms or 0),
        )
        for row in rows
    ]
    usage, cost, rounds = _sum_rows(rows)
    return TurnCost(
        message_id=message_id,
        usage=usage_breakdown(usage),
        cost=cost_breakdown(cost),
        rounds=rounds,
        agents=agents,
    )


@router.get("/conversations/{conversation_id}/cost", response_model=ConversationCost)
async def get_conversation_cost(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> ConversationCost:
    """A conversation's cumulative spend (对话累计 — the conversation-header chip).

    404 for a non-owner, consistent with the other conversation reads.
    """
    conv = await conv_repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    agg = await repo.aggregate_for_conversation(conversation_id, user_id=user.user_id)
    return ConversationCost(
        conversation_id=conversation_id,
        usage=usage_breakdown(agg["usage"]),
        cost=cost_breakdown(agg["cost"]),
        turns=agg["turns"],
    )


@router.get("/usage/summary", response_model=UsageSummary)
async def get_usage_summary(
    user: AuthUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> UsageSummary:
    """Account dashboard: today's tokens/cost, the month's cost + per-role payroll,
    the recent daily-cost trend, and the quota.

    Windows are bounded at the current UTC day / month start (MVP — a per-user
    timezone is a later refinement). ``month_by_role`` splits this month's spend by
    role (团队工资单, spend-desc) — the multi-agent differentiator;
    ``recent_daily_cost`` is the last ``_TREND_DAYS`` UTC days (zero-filled,
    oldest-first) for the sparkline. Also carries ``cny_per_usd`` so the client
    formats money from the single server-owned rate.
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)

    today = await repo.aggregate_for_window(user_id=user.user_id, since=day_start)
    month = await repo.aggregate_for_window(user_id=user.user_id, since=month_start)
    month_by_role = await repo.aggregate_by_role_for_window(
        user_id=user.user_id, since=month_start
    )

    # 近 7 日趋势: zero-fill the daily map into a fixed, oldest-first series ending
    # today, so the sparkline is a stable length even for sparse spend.
    trend_start = day_start - timedelta(days=_TREND_DAYS - 1)
    daily = await repo.aggregate_daily_for_window(
        user_id=user.user_id, since=trend_start
    )
    recent_daily_cost = []
    for i in range(_TREND_DAYS):
        iso = (trend_start + timedelta(days=i)).date().isoformat()
        recent_daily_cost.append(DailyCost(date=iso, cost_total=daily.get(iso, 0)))

    return UsageSummary(
        today=UsageWindow(
            usage=usage_breakdown(today["usage"]),
            cost=cost_breakdown(today["cost"]),
            requests=today["turns"],
        ),
        month=UsageWindow(
            usage=usage_breakdown(month["usage"]),
            cost=cost_breakdown(month["cost"]),
            requests=month["turns"],
        ),
        month_by_role=[
            RoleCostLine(
                role=row["role"],
                cost_total=int(row["cost_total"]),
                turns=int(row["turns"]),
            )
            for row in month_by_role
        ],
        recent_daily_cost=recent_daily_cost,
        quota=QuotaStatus(
            daily_tokens=settings.quota_daily_tokens,
            monthly_cost_nano=int(settings.quota_monthly_cost_usd * NANO_PER_USD),
            daily_requests=settings.quota_daily_requests,
        ),
        cny_per_usd=settings.cny_per_usd,
        billing_mode=settings.billing_mode,
    )
