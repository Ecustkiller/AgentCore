"""Single source of truth for turning token usage into money (不变量 #2).

Every place that needs a cost calls :func:`calculate_cost` — there is no other
price table and no per-site arithmetic. Prices are USD per 1M tokens: DeepSeek from
``docs/03-AI核心/DeepSeek-V4-API参考.md`` §三 (authoritative); third-party vendors
(豆包/方舟) from the vendor's published CNY rate converted at ``CNY_PER_USD`` (see the
table comments). Per-input-length tiers + FX-from-config are the Phase 2 定价表 item.

Money is never a float. Costs are computed in :class:`~decimal.Decimal` and
returned as integer **nano-USD** (1 USD = 1e9 nano) — the canonical unit stored
in the ``cost_events`` ledger and carried over the API. Only the display layer
converts to CNY (via the single configured rate), so rounding never accretes
across a month of aggregation.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO
from agentcore.llm.provider.protocol import TokenUsage

logger = get_logger(__name__)

# 1 USD expressed in nano-USD. The ledger and API speak integer nano-USD.
NANO_PER_USD = 1_000_000_000

# 豆包 (Volcengine 方舟) routed model id — keyed WITH the ``doubao/`` prefix because
# that is the exact string that reaches calculate_cost: the ProviderRouter only strips
# the prefix when *calling* the vendor, so cost accounting still sees the original id.
# TODO(Phase 2 定价表): match by vendor prefix so a new dated version (…-2606xx) keeps
# its price instead of silently degrading to Flash.
DOUBAO_SEED_TURBO = "doubao/doubao-seed-2-1-turbo-260628"

# Qwen-VL-Max (通义千问视觉) — the default board 读图 reader via DashScope's
# OpenAI-compatible endpoint (AI协作白板.md §九.4). Keyed by the exact ``vision_model``
# config string that reaches calculate_cost (config/llm.py default). Other vision models
# (GLM-4V / GPT-4o / 本地 vLLM…) are user-selectable and fall back to the default tier +
# a logged warning until added — same posture as any unpriced model.
QWEN_VL_MAX = "qwen-vl-max"

# USD per 1M tokens. DeepSeek: docs/03-AI核心/DeepSeek-V4-API参考.md §三 (authoritative);
# cache_hit is ~50× cheaper than cache_miss — splitting input by hit/miss is what keeps
# the bill honest on multi-turn chats (DeepSeek prefix caching).
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
    # 豆包 doubao-seed-2.1-turbo via 火山方舟. Volcengine 豆包1.6 统一定价 (深度思考/非思考同价),
    # tiered by INPUT length; this is the 0–32K tier (input ¥0.8/1M, output ¥8/1M) — the
    # common case (debate prompts sit well under 32K). USD = CNY ÷ 7.2 (settings.cny_per_usd):
    # ¥0.8→$0.1111, ¥8→$1.1111. No usable cache tier here: the generic OpenAI-compatible
    # provider doesn't surface a prompt cache split, so input is always billed as a miss
    # (cache_hit mirrors cache_miss and is never exercised). Source: Volcengine 豆包大模型 1.6
    # 定价 (2025 FORCE). TODO(Phase 2 定价表): per-input-length tiers + FX from config.
    DOUBAO_SEED_TURBO: {
        "cache_hit": Decimal("0.1111"),
        "cache_miss": Decimal("0.1111"),
        "output": Decimal("1.1111"),
    },
    # Qwen-VL-Max via DashScope international (USD-denominated, the default compatible-mode
    # base_url): input $0.80/1M, output $3.20/1M, cache hit = 20% of input = $0.16/1M.
    # Source: 阿里云百炼模型价格 + help.aliyun.com/zh/model-studio Context Cache (命中缓存的输入
    # 按标准输入单价 20% 计费). The OpenAI-compatible usage block QwenVLReader parses surfaces no
    # prompt-cache split (it reads only prompt/completion_tokens), so input is always billed as
    # a miss today — cache_hit stays priced for when the reader learns to read
    # ``prompt_tokens_details.cached_tokens``.
    QWEN_VL_MAX: {
        "cache_hit": Decimal("0.16"),
        "cache_miss": Decimal("0.80"),
        "output": Decimal("3.20"),
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
    return pricing_for_model(model, billing_mode="platform")


def pricing_for_model(
    model: str, *, billing_mode: str | None = None
) -> dict[str, Decimal] | None:
    """Price card for ``model``, or ``None`` when billing skips cost (BYOK).

    BYOK: the user pays their own provider — the platform ledger records token usage
    with zero nano-USD. Platform mode keeps the existing vendor table.
    """
    if (billing_mode or settings.billing_mode) == "byok":
        return None
    return _PRICING.get(model) or _PRICING[_DEFAULT_MODEL]


_ZERO_COST = Cost(input=0, cached=0, output=0, total=0)


def calculate_cost(model: str, usage: TokenUsage, *, billing_mode: str | None = None) -> Cost:
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
    mode = billing_mode or settings.billing_mode
    if mode == "byok":
        return _ZERO_COST

    p = pricing_for_model(model, billing_mode=mode)
    assert p is not None  # platform branch always resolves a card
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


def cache_savings(
    model: str, usage: TokenUsage, *, billing_mode: str | None = None
) -> int:
    """Nano-USD saved by prefix-cache hits this run vs. paying the miss price.

    ``cache_hit_tokens × (miss_price − hit_price)`` — powers the「前缀缓存替你省了
    ¥X」彩蛋 (§七E). Zero when nothing hit the cache.
    """
    p = pricing_for_model(model, billing_mode=billing_mode)
    if p is None:
        return 0
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
