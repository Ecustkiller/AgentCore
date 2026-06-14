"""Cost & usage observability endpoints (团队工资单 + 对话累计 + 账户仪表盘).

成本是产品差异点：AgentCore 是 multi-agent，花销天然能按 Agent/角色拆开，所以这些
读接口呈现的是「团队工资单」而非单一总额。

All three reads are scoped to the authenticated user via ``cost_events.user_id``,
so a non-owner can never read another user's spend (IDOR-safe) — the message /
conversation endpoints additionally 404 or return empty rather than leaking
existence. The ledger (``cost_events``) is the truth source for real money spent
(不变量 #1); ``Message.usage`` is only a display snapshot.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_cost_event_repo,
)
from agentcore.api.schemas import (
    AgentCostLine,
    ConversationCost,
    CostBreakdown,
    QuotaStatus,
    TurnCost,
    UsageBreakdown,
    UsageSummary,
    UsageWindow,
)
from agentcore.config import settings
from agentcore.core.errors import NotFoundError
from agentcore.db.models import CostEvent
from agentcore.db.repositories import ConversationRepository, CostEventRepository
from agentcore.llm.pricing import NANO_PER_USD, nano_usd_to_cny

router = APIRouter(tags=["usage"])


def _cost_breakdown(cost: dict) -> CostBreakdown:
    """Map a ledger cost dict to the API schema, attaching the display CNY value."""
    total = int(cost.get("total", 0))
    return CostBreakdown(
        input=int(cost.get("input", 0)),
        cached=int(cost.get("cached", 0)),
        output=int(cost.get("output", 0)),
        total=total,
        currency=str(cost.get("currency", "USD")),
        cny_total=nano_usd_to_cny(total, settings.cny_per_usd),
    )


def _usage_breakdown(tokens: dict) -> UsageBreakdown:
    return UsageBreakdown(
        input=int(tokens.get("input", 0)),
        output=int(tokens.get("output", 0)),
        reasoning=int(tokens.get("reasoning", 0)),
        cache_hit=int(tokens.get("cache_hit", 0)),
        cache_miss=int(tokens.get("cache_miss", 0)),
    )


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
            usage=_usage_breakdown(row.tokens or {}),
            cost=_cost_breakdown(row.cost or {}),
            duration_ms=int(row.duration_ms or 0),
        )
        for row in rows
    ]
    usage, cost, rounds = _sum_rows(rows)
    return TurnCost(
        message_id=message_id,
        usage=_usage_breakdown(usage),
        cost=_cost_breakdown(cost),
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
        raise NotFoundError("Conversation not found")
    agg = await repo.aggregate_for_conversation(conversation_id, user_id=user.user_id)
    return ConversationCost(
        conversation_id=conversation_id,
        usage=_usage_breakdown(agg["usage"]),
        cost=_cost_breakdown(agg["cost"]),
        turns=agg["turns"],
    )


@router.get("/usage/summary", response_model=UsageSummary)
async def get_usage_summary(
    user: AuthUser,
    repo: CostEventRepository = Depends(get_cost_event_repo),
) -> UsageSummary:
    """Account dashboard: today's tokens/cost, the month's cost, and the quota.

    Windows are bounded at the current UTC day / month start (MVP — a per-user
    timezone is a later refinement). Also carries ``cny_per_usd`` so the client
    formats money from the single server-owned rate.
    """
    now = datetime.now(UTC)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    month_start = day_start.replace(day=1)

    today = await repo.aggregate_for_window(user_id=user.user_id, since=day_start)
    month = await repo.aggregate_for_window(user_id=user.user_id, since=month_start)

    return UsageSummary(
        today=UsageWindow(
            usage=_usage_breakdown(today["usage"]),
            cost=_cost_breakdown(today["cost"]),
            requests=today["turns"],
        ),
        month=UsageWindow(
            usage=_usage_breakdown(month["usage"]),
            cost=_cost_breakdown(month["cost"]),
            requests=month["turns"],
        ),
        quota=QuotaStatus(
            daily_tokens=settings.quota_daily_tokens,
            monthly_cost_nano=int(settings.quota_monthly_cost_usd * NANO_PER_USD),
            daily_requests=settings.quota_daily_requests,
        ),
        cny_per_usd=settings.cny_per_usd,
    )
