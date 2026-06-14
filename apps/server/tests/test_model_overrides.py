"""Tests for per-agent model overrides (提案 B).

Covers ``llm.config.apply_overrides`` — the upgrade-only clamp that folds a
worker's optional ``thinking`` / ``reasoning_effort`` declaration onto its tier
baseline.
"""

from agentcore.llm.config import ModelProfile, apply_overrides

# Synthetic baselines kept local so the test pins apply_overrides' clamp logic,
# not whatever the registry holds. FAST is intentionally a NON-thinking baseline
# (unlike the live agent.fast tier, which now thinks at "high") so the
# upgrade-only cases below can meaningfully exercise the False→True transition.
FAST = ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=4)
STRONG = ModelProfile(model="m", thinking=True, reasoning_effort="high", max_rounds=28)
MAXED = ModelProfile(model="m", thinking=True, reasoning_effort="max", max_rounds=28)


# --- apply_overrides: no declaration keeps the tier default ---


def test_no_override_returns_same_object():
    assert apply_overrides(STRONG) is STRONG
    assert apply_overrides(FAST) is FAST


def test_redundant_override_returns_same_object():
    # Declaring exactly the tier default is a no-op.
    assert apply_overrides(STRONG, thinking=True, reasoning_effort="high") is STRONG


# --- apply_overrides: upgrades take effect ---


def test_strong_unlocks_max():
    out = apply_overrides(STRONG, reasoning_effort="max")
    assert (out.thinking, out.reasoning_effort) == (True, "max")


def test_fast_thinking_on_defaults_to_high():
    out = apply_overrides(FAST, thinking=True)
    assert (out.thinking, out.reasoning_effort) == (True, "high")


def test_effort_declaration_implies_thinking():
    # Raising effort on a non-thinking tier implies thinking (effort is
    # meaningless otherwise).
    out = apply_overrides(FAST, reasoning_effort="max")
    assert (out.thinking, out.reasoning_effort) == (True, "max")


# --- apply_overrides: downgrades are ignored (upgrade-only) ---


def test_thinking_off_is_ignored_on_strong():
    out = apply_overrides(STRONG, thinking=False)
    assert (out.thinking, out.reasoning_effort) == (True, "high")
    assert out is STRONG  # nothing changed → same object


def test_lower_effort_is_ignored():
    out = apply_overrides(MAXED, reasoning_effort="high")
    assert (out.thinking, out.reasoning_effort) == (True, "max")


def test_thinking_off_cannot_undo_an_effort_upgrade():
    out = apply_overrides(FAST, thinking=False, reasoning_effort="max")
    assert (out.thinking, out.reasoning_effort) == (True, "max")


def test_unknown_effort_value_is_ignored():
    out = apply_overrides(STRONG, reasoning_effort="ultra")
    assert out is STRONG
