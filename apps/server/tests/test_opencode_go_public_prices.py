"""OpenCode Go public-list USD (admin windows). Product Flash CNY is official list."""

from datetime import UTC, datetime

from agentcore.billing.opencode_go_public_prices import (
    MODEL_ID,
    PRICE_AS_OF,
    estimate_go_public_usd_nano,
    is_opencode_go_peak,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH, OPENCODE_GO_V41_FLASH

# Off-Peak noon / Peak 02:00 — same weekday, different cards.
_OFF = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
_PEAK = datetime(2026, 8, 18, 2, 0, tzinfo=UTC)


def _tokens(
    *,
    input: int = 0,
    output: int = 0,
    reasoning: int = 0,
    cache_hit: int = 0,
    cache_miss: int = 0,
) -> dict[str, int]:
    return {
        "input": input,
        "output": output,
        "reasoning": reasoning,
        "cache_hit": cache_hit,
        "cache_miss": cache_miss,
    }


def test_price_as_of_is_the_verified_capture_date():
    assert PRICE_AS_OF.isoformat() == "2026-09-10"


def test_peak_hours_are_half_open_utc_windows_on_weekdays():
    assert is_opencode_go_peak(datetime(2026, 8, 18, 0, 59, tzinfo=UTC)) is False
    assert is_opencode_go_peak(datetime(2026, 8, 18, 1, 0, tzinfo=UTC)) is True
    assert is_opencode_go_peak(datetime(2026, 8, 18, 3, 59, tzinfo=UTC)) is True
    assert is_opencode_go_peak(datetime(2026, 8, 18, 4, 0, tzinfo=UTC)) is False
    assert is_opencode_go_peak(datetime(2026, 8, 18, 5, 59, tzinfo=UTC)) is False
    assert is_opencode_go_peak(datetime(2026, 8, 18, 6, 0, tzinfo=UTC)) is True
    assert is_opencode_go_peak(datetime(2026, 8, 18, 9, 59, tzinfo=UTC)) is True
    assert is_opencode_go_peak(datetime(2026, 8, 18, 10, 0, tzinfo=UTC)) is False


def test_weekend_peak_hours_are_off_peak():
    saturday = datetime(2026, 8, 22, 2, 0, tzinfo=UTC)
    sunday = datetime(2026, 8, 23, 7, 0, tzinfo=UTC)
    assert saturday.weekday() == 5
    assert sunday.weekday() == 6
    assert is_opencode_go_peak(saturday) is False
    assert is_opencode_go_peak(sunday) is False


def _est(tokens: dict | None, at, *, model: str = MODEL_ID) -> int:
    return estimate_go_public_usd_nano(tokens, at, model=model)


def test_off_peak_million_token_tiers():
    # 1M @ $0.15 / $0.60 / $0.003 → 150e6 / 600e6 / 3e6 nano-USD.
    assert _est(_tokens(cache_miss=1_000_000, input=1_000_000), _OFF) == 150_000_000
    assert _est(_tokens(output=1_000_000), _OFF) == 600_000_000
    assert _est(_tokens(cache_hit=1_000_000, input=1_000_000), _OFF) == 3_000_000


def test_peak_is_double_off_peak_not_a_blend():
    off = _est(_tokens(cache_miss=1_000_000, input=1_000_000), _OFF)
    peak = _est(_tokens(cache_miss=1_000_000, input=1_000_000), _PEAK)
    assert off == 150_000_000
    assert peak == 300_000_000


def test_input_already_includes_cache_do_not_double_count():
    """``input`` is prompt_tokens (hit+miss). Pricing input@Input + hit@Read would 双计."""
    tokens = _tokens(input=1_000_000, cache_hit=400_000, cache_miss=600_000)
    got = _est(tokens, _OFF)
    # 400k Cached Read + 600k Input; NOT + 1M Input.
    expected = 400_000 * 3 + 600_000 * 150  # nano via ×1000 already in 3 / 150
    assert got == expected
    assert got != 400_000 * 3 + 1_000_000 * 150


def test_output_already_includes_reasoning_do_not_add_again():
    tokens = _tokens(output=100_000, reasoning=80_000)
    got = _est(tokens, _OFF)
    assert got == 100_000 * 600  # output only
    assert got != 180_000 * 600


def test_missing_cache_split_prices_whole_prompt_as_input():
    tokens = _tokens(input=1_000_000, cache_hit=0, cache_miss=0)
    assert _est(tokens, _OFF) == 150_000_000


def test_empty_or_junk_tokens_are_zero():
    assert _est(None, _OFF) == 0
    assert _est({}, _OFF) == 0
    assert _est({"input": "nope", "output": None}, _OFF) == 0


def test_estimate_go_public_usd_nano_does_not_apply_flash_price_to_other_models():
    """Heterogeneous catalog ids must not inherit the Flash public list."""
    tokens = _tokens(cache_miss=1_000_000, input=1_000_000)
    flash = _est(tokens, _OFF, model=MODEL_ID)
    assert flash == 150_000_000
    assert _est(tokens, _OFF, model="glm-5.2") == 0
    assert _est(tokens, _OFF, model="deepseek-v4-flash-free") == 0
    # Prefix of the priced id is still a different model.
    assert _est(tokens, _OFF, model="deepseek-v4-flash-pro") == 0
    assert _est(tokens, _OFF, model="") == 0
    # Leftover V4 Flash ledger rows share the public list (quota caps differ).
    assert _est(tokens, _OFF, model=DEEPSEEK_V4_FLASH) == flash
    assert _est(tokens, _OFF, model=OPENCODE_GO_V41_FLASH) == flash
