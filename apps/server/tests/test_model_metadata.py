"""Unit tests for model display enrichment (exact / family / derived)."""

from agentcore.llm.model_metadata import (
    CAPABILITY_REASONING,
    CAPABILITY_TOOLS,
    CAPABILITY_VISION,
    model_metadata_for,
)


def test_kimi_k26_exact_display_not_family_k2():
    """kimi-k2.6 must not inherit family-prefix「Kimi K2」."""
    meta = model_metadata_for("kimi-k2.6")
    assert meta.display_name == "Kimi K2.6"
    assert meta.vendor == "Moonshot"
    assert meta.capabilities == frozenset(
        {CAPABILITY_VISION, CAPABILITY_TOOLS, CAPABILITY_REASONING}
    )
    assert meta.context_length == 256_000


def test_kimi_k3_exact_display():
    meta = model_metadata_for("kimi-k3")
    assert meta.display_name == "Kimi K3"
    assert meta.vendor == "Moonshot"
    assert meta.capabilities == frozenset(
        {CAPABILITY_VISION, CAPABILITY_TOOLS, CAPABILITY_REASONING}
    )
    assert meta.context_length == 1_000_000


def test_kimi_k25_unchanged():
    meta = model_metadata_for("kimi-k2.5")
    assert meta.display_name == "Kimi K2.5"


def test_hy3_exact_display():
    meta = model_metadata_for("hy3")
    assert meta.display_name == "Hy3"
    assert meta.vendor == "腾讯 Hy"
    assert meta.capabilities == frozenset({CAPABILITY_TOOLS, CAPABILITY_REASONING})
    assert meta.context_length == 256_000


def test_hy3_preview_exact_display_not_family_hy3():
    """hy3-preview must not inherit family-prefix「Hy3」."""
    meta = model_metadata_for("hy3-preview")
    assert meta.display_name == "Hy3 Preview"
    assert meta.vendor == "腾讯 Hy"
    assert meta.capabilities == frozenset({CAPABILITY_TOOLS, CAPABILITY_REASONING})
    assert meta.context_length == 256_000
