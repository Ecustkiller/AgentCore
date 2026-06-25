"""LLM provider assembly.

The single place that builds a configured ``LLMProvider``, so API key / base URL
wiring lives in one spot rather than being repeated at every call site (chat
pipeline, conversation service, memory consolidation).

BYOK (config.billing_mode): the caller resolves the user's own credentials
(llm/byok.py) and passes them in, so the turn runs on the user's DeepSeek key.
When no credentials are given the global server key is used — the platform-pays
fallback, kept behind the billing-mode switch (empty in the BYOK beta).
"""

from agentcore.config import settings
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.protocol import LLMProvider
from agentcore.llm.router import ProviderRouter


def build_provider(credentials: LLMCredentials | None = None) -> DeepSeekProvider:
    """Construct the LLM provider for a turn.

    ``credentials`` (resolved per-user in BYOK mode) override the API key + base
    URL so the turn runs on the user's own DeepSeek quota; ``None`` falls back to
    the global server config (platform mode / background fallback).
    """
    if credentials is not None:
        return DeepSeekProvider(
            api_key=credentials.api_key,
            base_url=credentials.base_url,
            extra_headers=credentials.extra_headers,
        )
    return DeepSeekProvider(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )


# 厂商前缀 → (key 设置名, base_url 设置名)。空 key 的厂商不注册（路由回退 DeepSeek）。
# 前缀即 ProviderRouter 识别的 `provider/model` 中的 provider 段（如 kimi/kimi-k2.6）。
_VENDOR_PROVIDERS: dict[str, tuple[str, str]] = {
    "kimi": ("moonshot_api_key", "moonshot_base_url"),
    "zhipu": ("zhipu_api_key", "zhipu_base_url"),
    "doubao": ("doubao_api_key", "doubao_base_url"),
}


def _vendor_extras() -> dict[str, OpenAICompatibleProvider]:
    """已配置 key 的厂商 provider 注册表（空 key 不注册 → 该前缀路由回退默认）。

    额外厂商（Kimi / 智谱 / 豆包）凡配了 key 即注册，可被 ``provider/model`` 前缀路由命中
    （「真·多模型辩手」执行地基）。无任何厂商 key 时返回空 → 路由器退化为「只有默认」。
    """
    extras: dict[str, OpenAICompatibleProvider] = {}
    for prefix, (key_attr, url_attr) in _VENDOR_PROVIDERS.items():
        api_key = getattr(settings, key_attr, "")
        if not api_key:
            continue
        extras[prefix] = OpenAICompatibleProvider(
            name=prefix,
            api_key=api_key,
            base_url=getattr(settings, url_attr),
        )
    return extras


def build_router_around(default: LLMProvider) -> ProviderRouter:
    """Wrap an ALREADY-built default provider with configured vendor routing.

    回合管线先经【可被测试打桩的】``build_provider`` 拿到默认 provider，再用本函数包成路由
    器：这样 ``test_pipeline_governance`` 对 ``build_provider`` 的打桩仍命中（脚本化 provider
    成为路由器默认、无前缀调用照常落它），而带 ``provider/model`` 前缀的调用（仅辩论辩手 side
    会带）路由到对应厂商。无任何厂商 key 时只是「包了一层、仍只有默认」，零行为变化。路由器
    成为回合级 llm 的持有者，其 :meth:`ProviderRouter.close` 一并释放默认 + 厂商 client。
    """
    return ProviderRouter(default=default, providers=_vendor_extras())


def build_router(credentials: LLMCredentials | None = None) -> ProviderRouter:
    """Build a :class:`ProviderRouter` = DeepSeek default + configured vendor providers.

    默认 provider 仍是 DeepSeek（``build_provider``，BYOK 或全局 key），承接无前缀 / 未注册
    前缀的调用——故普通对话 / 委派零行为变化。见 :func:`build_router_around` 的打桩兼容说明。
    """
    return build_router_around(build_provider(credentials))
