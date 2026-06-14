"""Tests for the single pricing function (llm.pricing).

Pins the money math: input is split by cache hit/miss, output includes
reasoning, everything is integer nano-USD, and an unknown model degrades to the
Flash tier instead of crashing. Prices are asserted against the authoritative
table in docs/06-参考/DeepSeek-V4-API参考.md §三.
"""

from agentcore.llm.config import DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO
from agentcore.llm.pricing import (
    NANO_PER_USD,
    cache_savings,
    calculate_cost,
    nano_usd_to_cny,
)
from agentcore.llm.protocol import TokenUsage


def _usage(**kw: int) -> TokenUsage:
    return TokenUsage(**kw)


# --- calculate_cost: per-1M prices land on exact nano-USD ---


def test_flash_one_million_each_line():
    # 1M cache_miss @ $0.14, 1M output @ $0.28 → exact nano-USD.
    usage = _usage(
        input_tokens=1_000_000,
        cache_miss_tokens=1_000_000,
        output_tokens=1_000_000,
    )
    cost = calculate_cost(DEEPSEEK_V4_FLASH, usage)
    assert cost.input == 140_000_000  # 0.14 USD
    assert cost.cached == 0
    assert cost.output == 280_000_000  # 0.28 USD
    assert cost.total == 420_000_000  # 0.42 USD
    assert cost.currency == "USD"


def test_input_splits_cache_hit_vs_miss():
    # 1M hit @ $0.0028 + 1M miss @ $0.14: hit is ~50× cheaper. `cached` re-states
    # just the hit portion; `input` is the sum.
    usage = _usage(
        input_tokens=2_000_000,
        cache_hit_tokens=1_000_000,
        cache_miss_tokens=1_000_000,
    )
    cost = calculate_cost(DEEPSEEK_V4_FLASH, usage)
    assert cost.cached == 2_800_000  # 0.0028 USD
    assert cost.input == 2_800_000 + 140_000_000
    assert cost.output == 0
    assert cost.total == cost.input


def test_pro_prices():
    usage = _usage(
        input_tokens=1_000_000,
        cache_hit_tokens=1_000_000,
        cache_miss_tokens=0,
        output_tokens=1_000_000,
    )
    cost = calculate_cost(DEEPSEEK_V4_PRO, usage)
    assert cost.cached == 3_625_000  # 0.003625 USD
    assert cost.input == 3_625_000
    assert cost.output == 870_000_000  # 0.87 USD
    assert cost.total == 3_625_000 + 870_000_000


def test_unknown_model_falls_back_to_flash():
    usage = _usage(output_tokens=1_000_000)
    assert calculate_cost("totally-unknown", usage) == calculate_cost(
        DEEPSEEK_V4_FLASH, usage
    )


def test_zero_usage_is_zero_cost():
    cost = calculate_cost(DEEPSEEK_V4_FLASH, _usage())
    assert (cost.input, cost.cached, cost.output, cost.total) == (0, 0, 0, 0)


def test_small_token_counts_round_half_up():
    # 100 output tokens @ $0.28/1M = 28_000 nano exactly; 1 token rounds.
    assert calculate_cost(DEEPSEEK_V4_FLASH, _usage(output_tokens=100)).output == 28_000
    # 1 token: 0.28 * 1000 = 280 nano (exact, no rounding needed here).
    assert calculate_cost(DEEPSEEK_V4_FLASH, _usage(output_tokens=1)).output == 280


# --- cache_savings: the「省了多少」彩蛋 ---


def test_cache_savings_is_hit_tokens_times_price_gap():
    usage = _usage(cache_hit_tokens=1_000_000)
    # miss(0.14) − hit(0.0028) = 0.1372 USD over 1M tokens.
    assert cache_savings(DEEPSEEK_V4_FLASH, usage) == 140_000_000 - 2_800_000


def test_no_cache_hits_means_no_savings():
    assert cache_savings(DEEPSEEK_V4_FLASH, _usage(cache_miss_tokens=1_000_000)) == 0


# --- nano_usd_to_cny: display-only conversion, rounded to fen ---


def test_nano_to_cny_rounds_to_fen():
    # 1 USD → 7.2 CNY at the default rate.
    assert nano_usd_to_cny(NANO_PER_USD, 7.2) == 7.2
    # 0.14 USD → 1.008 CNY → 1.01 (round half up to fen).
    assert nano_usd_to_cny(140_000_000, 7.2) == 1.01


def test_nano_to_cny_zero():
    assert nano_usd_to_cny(0, 7.2) == 0.0
