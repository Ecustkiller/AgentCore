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


def test_hy_tokenhub_preset_defaults_to_hy3():
    preset = match_byok_provider_preset("https://tokenhub.tencentmaas.com/v1")
    assert preset is not None
    assert preset.id == "hy"
    assert preset.label == "腾讯 Hy (TokenHub)"
    assert preset.default_model == "hy3"
    assert preset.models == ("hy3", "hy3-preview")


def test_hy_tokenhub_aliases_yield_same_models():
    urls = (
        "https://tokenhub.tencentmaas.cn/v1",
        "https://tokenhub-intl.tencentmaas.com/v1",
        "https://tokenhub-intl.tencentmaas.cn/v1",
        "https://tokenhub.tencentmaas.com/v1/",  # trailing slash normalize
    )
    for url in urls:
        models = preset_models_for_base_url(url)
        assert models == ("hy3", "hy3-preview"), url


def test_jiurelay_preset_defaults_and_models():
    preset = match_byok_provider_preset("https://jiurelay.com/openai/v1")
    assert preset is not None
    assert preset.id == "jiurelay"
    assert preset.label == "JiuRelay"
    assert preset.default_model == "glm-5.2"
    assert preset.models == ("glm-5.2", "deepseek-v4-flash-0731", "grok-4.5")


def test_jiurelay_trailing_slash_matches():
    preset = match_byok_provider_preset("https://jiurelay.com/openai/v1/")
    assert preset is not None
    assert preset.id == "jiurelay"
    assert preset_models_for_base_url("https://jiurelay.com/openai/v1/") == (
        "glm-5.2",
        "deepseek-v4-flash-0731",
        "grok-4.5",
    )
