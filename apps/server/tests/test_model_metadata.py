"""Unit tests for model display enrichment (exact / family / derived)."""

from agentcore.llm.model_metadata import (
    CAPABILITY_REASONING,
    CAPABILITY_TOOLS,
    CAPABILITY_VISION,
    model_has_curated_vision,
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


def test_family_variant_appends_qualifier_not_identical_label():
    """Dated / channel siblings must not share the family's bare display_name."""
    base = model_metadata_for("deepseek-v4-flash")
    assert base.display_name == "DeepSeek V4 Flash"

    dated = model_metadata_for("deepseek-v4-flash-0731")
    assert dated.display_name == "DeepSeek V4 Flash · 0731"
    assert dated.vendor == base.vendor
    assert dated.capabilities == base.capabilities
    assert dated.context_length == base.context_length

    free = model_metadata_for("deepseek/deepseek-v4-flash-free")
    assert free.display_name == "DeepSeek V4 Flash Free"
    assert free.vendor == "DeepSeek"
    assert free.capabilities == base.capabilities
    assert free.context_length == base.context_length


def test_family_variant_doubao_seed_and_o3_mini():
    """Other presets that previously collapsed to identical family labels."""
    seed = model_metadata_for("doubao/doubao-seed-2-1-turbo-260628")
    assert seed.display_name == "豆包 Seed · 2-1-turbo-260628"
    assert seed.vendor == "豆包 (火山方舟)"

    o3_mini = model_metadata_for("o3-mini")
    assert o3_mini.display_name == "OpenAI o3 · mini"
    assert CAPABILITY_REASONING in o3_mini.capabilities


def test_exact_curated_branding_beats_auto_qualifier():
    """Exact rows keep curated labels (not auto「· jiu」/「· preview」)."""
    assert model_metadata_for("glm-5.2-jiu").display_name == "GLM-5.2 · JiuRelay"
    assert model_metadata_for("hy3-preview").display_name == "Hy3 Preview"
    assert model_metadata_for("gpt-4o-mini").display_name == "GPT-4o mini"


def test_family_prefix_requires_separator_boundary():
    """Bare startswith without a separator must not claim a longer sibling id."""
    # No curated ``gpt-4`` row today; still guard the helper contract via a
    # non-boundary case that would wrongly inherit if we used raw startswith.
    mystery = model_metadata_for("deepseek-v4-flashy")
    assert mystery.display_name != "DeepSeek V4 Flash"
    assert "flashy" in mystery.display_name.lower() or "Flashy" in mystery.display_name


def test_model_has_curated_vision_ignores_keyword_derive():
    """Native multimodal gate must not trust keyword-inferred vision tags."""
    assert model_has_curated_vision("gpt-4o") is True
    assert model_has_curated_vision("kimi-k2.5") is True
    assert model_has_curated_vision("deepseek-v4-pro") is False
    # Family-prefix dated variant still counts as curated for the gate.
    assert model_has_curated_vision("gpt-4o-custom-build") is True
    # Keyword-derived catalog may tag these, but curated gate stays closed.
    assert CAPABILITY_VISION in model_metadata_for("acme-vl-special").capabilities
    assert model_has_curated_vision("acme-vl-special") is False
    assert model_has_curated_vision("mystery-4o-clone") is False
