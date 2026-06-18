"""Shared mappers: a ledger aggregate dict → the cost/usage API schema.

Single source for turning a ``cost_events`` rollup (the repository's dict shape)
into the wire schema, shared by the per-user 用量 endpoints (``usage.py``) and the
admin 全站看板 (``admin.py``). The ledger is already priced (用量/成本不变量 #2:
``calculate_cost`` ran at write time), so this only *reads* the stored components
— it never re-prices. The display CNY value is derived from the single
server-owned rate (``settings.cny_per_usd``) so no client ever hard-codes FX.
"""

from agentcore.api.schemas import CostBreakdown, UsageBreakdown
from agentcore.config import settings
from agentcore.llm.pricing import nano_usd_to_cny


def cost_breakdown(cost: dict) -> CostBreakdown:
    """Map a ledger cost dict (integer nano-USD components) to the API schema,
    attaching the display CNY value via the single server-owned rate."""
    total = int(cost.get("total", 0))
    return CostBreakdown(
        input=int(cost.get("input", 0)),
        cached=int(cost.get("cached", 0)),
        output=int(cost.get("output", 0)),
        total=total,
        currency=str(cost.get("currency", "USD")),
        cny_total=nano_usd_to_cny(total, settings.cny_per_usd),
    )


def usage_breakdown(tokens: dict) -> UsageBreakdown:
    """Map a ledger token dict to the API schema (absent keys → 0)."""
    return UsageBreakdown(
        input=int(tokens.get("input", 0)),
        output=int(tokens.get("output", 0)),
        reasoning=int(tokens.get("reasoning", 0)),
        cache_hit=int(tokens.get("cache_hit", 0)),
        cache_miss=int(tokens.get("cache_miss", 0)),
    )
