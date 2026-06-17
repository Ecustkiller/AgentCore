"""Single source of truth for turning token usage into money (不变量 #2).

Every place that needs a cost calls :func:`calculate_cost` — there is no other
price table and no per-site arithmetic. Prices are USD per 1M tokens, taken from
``docs/06-参考/DeepSeek-V4-API参考.md`` §三 (authoritative).

Money is never a float. Costs are computed in :class:`~decimal.Decimal` and
returned as integer **nano-USD** (1 USD = 1e9 nano) — the canonical unit stored
in the ``cost_events`` ledger and carried over the API. Only the display layer
converts to CNY (via the single configured rate), so rounding never accretes
across a month of aggregation.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from agentcore.core.logging import get_logger
from agentcore.llm.config import DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO
from agentcore.llm.protocol import TokenUsage

logger = get_logger(__name__)

# 1 USD expressed in nano-USD. The ledger and API speak integer nano-USD.
NANO_PER_USD = 1_000_000_000

# USD per 1M tokens (source: docs/06-参考/DeepSeek-V4-API参考.md §三, authoritative).
# cache_hit is ~50× cheaper than cache_miss — splitting input by hit/miss is what
# keeps the bill honest on multi-turn chats (DeepSeek prefix caching).
_PRICING: dict[str, dict[str, Decimal]] = {
    DEEPSEEK_V4_FLASH: {
        "cache_hit": Decimal("0.0028"),
        "cache_miss": Decimal("0.14"),
        "output": Decimal("0.28"),
    },
    DEEPSEEK_V4_PRO: {
        "cache_hit": Decimal("0.003625"),
        "cache_miss": Decimal("0.435"),
        "output": Decimal("0.87"),
    },
}

# Unknown / unset model falls back to the cheaper Flash tier rather than failing:
# a missing price must never crash a turn (the bill degrades, the chat does not).
_DEFAULT_MODEL = DEEPSEEK_V4_FLASH

# tokens × (USD / 1M tokens) → nano-USD  ==  tokens × usd_per_million × 1000.
_USD_PER_MILLION_TO_NANO = Decimal(1000)


@dataclass(frozen=True)
class Cost:
    """A run's (or turn's) cost in integer nano-USD.

    ``input`` is the whole input bill (cached + uncached); ``cached`` re-states
    just the cache-hit portion so the UI can show「省了多少」without re-pricing.
    ``output`` already includes reasoning tokens (reasoning is a billed subset of
    completion, not a separate line). ``total == input + output``.
    """

    input: int
    cached: int
    output: int
    total: int
    currency: str = "USD"


def _nano(tokens: int, price_per_million: Decimal) -> int:
    """Price ``tokens`` at ``price_per_million`` USD/1M, as integer nano-USD."""
    if tokens <= 0:
        return 0
    value = Decimal(tokens) * price_per_million * _USD_PER_MILLION_TO_NANO
    return int(value.quantize(Decimal(1), rounding=ROUND_HALF_UP))


def pricing_for(model: str) -> dict[str, Decimal]:
    """The price card for a model, falling back to the default (Flash) tier."""
    return _PRICING.get(model) or _PRICING[_DEFAULT_MODEL]


def calculate_cost(model: str, usage: TokenUsage) -> Cost:
    """Convert a run's token usage into money — the only place this happens.

    Input is split by cache hit/miss (DeepSeek pre-splits the counts); output is
    priced whole (reasoning already included). Returns integer nano-USD.

    Two guards keep the bill honest when upstream usage is imperfect:

    - **Cache-split reconciliation**: pricing the input by hit/miss alone silently
      bills it as 0 whenever the cache split is absent but the prompt isn't — e.g.
      a BYOK ``base_url`` pointing at a proxy/gateway that returns standard
      OpenAI usage without DeepSeek's ``prompt_cache_{hit,miss}_tokens``, a model
      swap, or a dropped field. So the uncached count is reconciled to
      ``max(input_tokens − cache_hit, cache_miss)``: on the native DeepSeek path
      (``hit + miss == prompt``) this is a no-op, and when the split is missing
      the whole prompt is priced as a cache miss instead of vanishing.
    - **Fallback visibility**: an unknown/unset ``model`` degrades to the Flash
      tier (a missing price must never crash a turn), but that can undercount a
      Pro run ~3×, so the degrade is logged (``cost.pricing_fallback``) instead of
      happening silently.
    """
    p = pricing_for(model)
    if model not in _PRICING and (usage.input_tokens or usage.output_tokens):
        logger.warning(
            "cost.pricing_fallback",
            model=model or "(unset)",
            fallback=_DEFAULT_MODEL,
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
        )
    cache_miss_tokens = max(usage.input_tokens - usage.cache_hit_tokens, usage.cache_miss_tokens)
    cached = _nano(usage.cache_hit_tokens, p["cache_hit"])
    uncached = _nano(cache_miss_tokens, p["cache_miss"])
    output = _nano(usage.output_tokens, p["output"])
    input_total = cached + uncached
    return Cost(
        input=input_total,
        cached=cached,
        output=output,
        total=input_total + output,
    )


def cache_savings(model: str, usage: TokenUsage) -> int:
    """Nano-USD saved by prefix-cache hits this run vs. paying the miss price.

    ``cache_hit_tokens × (miss_price − hit_price)`` — powers the「前缀缓存替你省了
    ¥X」彩蛋 (§七E). Zero when nothing hit the cache.
    """
    p = pricing_for(model)
    full = _nano(usage.cache_hit_tokens, p["cache_miss"])
    paid = _nano(usage.cache_hit_tokens, p["cache_hit"])
    return max(full - paid, 0)


def nano_usd_to_cny(nano_usd: int, cny_per_usd: float) -> float:
    """Convert nano-USD to CNY yuan for display, rounded to fen (2 decimals).

    Display-only (the ledger stays USD nano). ``cny_per_usd`` is the single
    configured rate (``settings.cny_per_usd``), passed in to keep this pure.
    """
    yuan = Decimal(nano_usd) / Decimal(NANO_PER_USD) * Decimal(str(cny_per_usd))
    return float(yuan.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))
