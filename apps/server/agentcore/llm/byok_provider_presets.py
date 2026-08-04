"""BYOK vendor presets — server-side catalog seed aligned with desktop.

Mirrors ``apps/desktop/src/renderer/lib/byokProviderPresets.ts`` (baseUrl / aliases /
models / defaultModel). Catalog merge matches providers by normalized ``base_url``;
unknown endpoints get no preset rows.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ByokProviderPreset:
    id: str
    label: str
    base_url: str
    default_model: str
    models: tuple[str, ...]
    base_url_aliases: tuple[str, ...] = ()


BYOK_PROVIDER_PRESETS: tuple[ByokProviderPreset, ...] = (
    ByokProviderPreset(
        id="deepseek",
        label="DeepSeek",
        base_url="https://api.deepseek.com",
        base_url_aliases=("https://api.deepseek.com/v1",),
        default_model="deepseek-v4-flash",
        models=("deepseek-v4-flash", "deepseek-v4-pro"),
    ),
    ByokProviderPreset(
        id="openai",
        label="OpenAI",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o",
        models=("gpt-4o", "gpt-4o-mini", "o3-mini"),
    ),
    ByokProviderPreset(
        id="moonshot",
        label="Kimi (Moonshot)",
        base_url="https://api.moonshot.cn/v1",
        base_url_aliases=("https://api.moonshot.ai/v1",),
        default_model="kimi-k2.5",
        models=("kimi-k2.5", "kimi-k2", "moonshot-v1-8k", "moonshot-v1-32k"),
    ),
    ByokProviderPreset(
        id="zhipu",
        label="智谱 GLM",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        default_model="glm-4-plus",
        models=("glm-4-plus", "glm-4-flash", "glm-4-air"),
    ),
    ByokProviderPreset(
        id="doubao",
        label="豆包 (火山方舟)",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        default_model="doubao-pro-32k",
        models=("doubao-pro-32k", "doubao-lite-32k"),
    ),
    ByokProviderPreset(
        id="openrouter",
        label="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        default_model="openrouter/auto",
        models=(
            "openrouter/auto",
            "anthropic/claude-sonnet-4",
            "google/gemini-2.5-pro",
        ),
    ),
)


def normalize_byok_base_url(url: str) -> str:
    """Normalize base_url for preset matching (case, trailing slashes)."""
    normalized = url.strip().lower()
    while normalized.endswith("/"):
        normalized = normalized[:-1]
    return normalized


def _preset_base_urls(preset: ByokProviderPreset) -> tuple[str, ...]:
    return (preset.base_url, *preset.base_url_aliases)


def match_byok_provider_preset(base_url: str) -> ByokProviderPreset | None:
    """Return the preset whose canonical / alias base_url matches, else None."""
    normalized = normalize_byok_base_url(base_url)
    if not normalized:
        return None
    for preset in BYOK_PROVIDER_PRESETS:
        if any(
            normalize_byok_base_url(candidate) == normalized
            for candidate in _preset_base_urls(preset)
        ):
            return preset
    return None


def preset_models_for_base_url(base_url: str) -> tuple[str, ...]:
    """Model ids from the matching vendor preset, or empty when unknown/custom."""
    preset = match_byok_provider_preset(base_url)
    return preset.models if preset is not None else ()
