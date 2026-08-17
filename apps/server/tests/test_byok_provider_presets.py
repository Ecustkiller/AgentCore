"""Unit tests for BYOK vendor presets (Moonshot / Kimi catalog seed)."""

from agentcore.llm.byok_provider_presets import (
    BYOK_PROVIDER_PRESETS,
    is_opencode_go_base_url,
    is_opencode_zen_base_url,
    match_byok_provider_preset,
    normalize_byok_base_url,
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


def test_opencode_zen_preset_defaults_and_seed():
    preset = match_byok_provider_preset("https://opencode.ai/zen/v1")
    assert preset is not None
    assert preset.id == "opencode_zen"
    assert preset.label == "OpenCode Zen"
    assert preset.default_model == "deepseek-v4-flash"
    assert preset.models == ("deepseek-v4-flash", "kimi-k2.6", "glm-5.2")


def test_opencode_zen_trailing_slash_matches():
    preset = match_byok_provider_preset("https://opencode.ai/zen/v1/")
    assert preset is not None
    assert preset.id == "opencode_zen"
    assert preset_models_for_base_url("https://opencode.ai/zen/v1/") == (
        "deepseek-v4-flash",
        "kimi-k2.6",
        "glm-5.2",
    )


def test_opencode_go_preset_defaults_and_seed():
    preset = match_byok_provider_preset("https://opencode.ai/zen/go/v1")
    assert preset is not None
    assert preset.id == "opencode_go"
    assert preset.label == "OpenCode Go"
    assert preset.default_model == "deepseek-v4-flash"
    assert preset.models == ("deepseek-v4-flash", "deepseek-v4-pro", "glm-5.2")
    # /responses and /messages catalog ids stay off the chat/completions seed.
    assert "grok-4.5" not in preset.models
    assert "gpt-5.6-luna" not in preset.models
    assert "minimax-m2.7" not in preset.models
    assert "qwen3.7-max" not in preset.models
    assert "deepseek-v4-flash-free" not in preset.models


def test_opencode_go_trailing_slash_matches():
    preset = match_byok_provider_preset("https://opencode.ai/zen/go/v1/")
    assert preset is not None
    assert preset.id == "opencode_go"
    assert preset_models_for_base_url("https://opencode.ai/zen/go/v1/") == (
        "deepseek-v4-flash",
        "deepseek-v4-pro",
        "glm-5.2",
    )


def test_opencode_zen_and_go_urls_do_not_cross_match():
    zen = "https://opencode.ai/zen/v1"
    go = "https://opencode.ai/zen/go/v1"
    assert is_opencode_zen_base_url(zen) is True
    assert is_opencode_go_base_url(go) is True
    assert is_opencode_zen_base_url(go) is False
    assert is_opencode_go_base_url(zen) is False
    assert is_opencode_zen_base_url(go + "/") is False
    assert is_opencode_go_base_url(zen + "/") is False
    # Prefix/contains would lie; equality after normalize must not.
    assert go.startswith(zen) is False
    assert zen not in go
    assert match_byok_provider_preset("https://opencode.ai/zen") is None
    assert match_byok_provider_preset("https://opencode.ai/zen/v1/extra") is None


def test_byok_preset_base_urls_are_unique():
    seen: set[str] = set()
    for preset in BYOK_PROVIDER_PRESETS:
        urls = (preset.base_url, *preset.base_url_aliases)
        for url in urls:
            key = normalize_byok_base_url(url)
            assert key not in seen, key
            seen.add(key)
