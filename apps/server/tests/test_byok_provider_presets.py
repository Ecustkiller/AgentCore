"""Unit tests for BYOK vendor presets (Moonshot / Kimi catalog seed)."""

from agentcore.llm.byok_provider_presets import (
    match_byok_provider_preset,
    preset_models_for_base_url,
)


def test_moonshot_preset_defaults_to_kimi_k26():
    preset = match_byok_provider_preset("https://api.moonshot.cn/v1")
    assert preset is not None
    assert preset.id == "moonshot"
    assert preset.default_model == "kimi-k2.6"
    assert preset.models == ("kimi-k2.6", "kimi-k3", "kimi-k2.5")
    assert "kimi-k2" not in preset.models
    assert "moonshot-v1-8k" not in preset.models


def test_moonshot_alias_yields_same_models():
    models = preset_models_for_base_url("https://api.moonshot.ai/v1")
    assert models == ("kimi-k2.6", "kimi-k3", "kimi-k2.5")
