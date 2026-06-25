"""ProviderRouter —— 按模型名把一次 LLM 调用分发到对应厂商 provider。

落实 ``.cursor/rules/llm.mdc`` 的 **Provider 路由规则**（此前为纸面设计、单 provider）：

1. **前缀匹配**：``provider/model``（如 ``kimi/kimi-k2.6``、``zhipu/glm-5.2``、
   ``doubao/ep-xxx``）→ 路由到该 ``provider``，实际模型取 ``/`` 后部分。
2. **回退**：无前缀或前缀未注册 → 默认 provider（DeepSeek），模型名原样透传
   （故 ``deepseek-v4-flash`` / ``deepseek-v4-pro`` 维持现状，零行为变化）。

路由器本身实现 :class:`~agentcore.llm.protocol.LLMProvider`，可直接当作执行器 / 主持人的
``llm`` 注入：每次调用读 ``request.model`` 决定去向，并把带前缀的模型名改写成厂商真实模型名
后下发。这是「真·多模型辩论」的执行支点——某辩手 side 声明 ``kimi/kimi-k2.6``，其节点的
``request.model`` 即被路由到 Kimi provider。

→ 见设计: docs/03-AI核心/辩论编排设计.md（多模型辩手）、.cursor/rules/llm.mdc（Provider 路由）
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

from agentcore.core.logging import get_logger
from agentcore.llm.protocol import LLMChunk, LLMProvider, LLMRequest, LLMResponse

logger = get_logger(__name__)

# 模型名里「厂商前缀」与「真实模型名」的分隔符。
_PREFIX_SEP = "/"


class ProviderRouter:
    """Dispatch each LLM call to a vendor provider by ``request.model`` prefix.

    ``default`` 承接无前缀 / 未注册前缀的调用（DeepSeek，BYOK 或全局 key）；``providers``
    是 ``{前缀: provider}`` 注册表（由 :func:`~agentcore.llm.factory.build_router` 据已配置的
    厂商 key 组装）。空注册表 ⇒ 等价于「只有 DeepSeek」，与改造前完全一致。
    """

    def __init__(
        self, *, default: LLMProvider, providers: dict[str, LLMProvider] | None = None
    ) -> None:
        self._default = default
        self._providers: dict[str, LLMProvider] = dict(providers or {})

    @property
    def available_prefixes(self) -> frozenset[str]:
        """已注册的厂商前缀（可被 ``provider/model`` 路由命中的集合）。"""
        return frozenset(self._providers)

    def _route(self, model: str) -> tuple[LLMProvider, str]:
        """(provider, 真实模型名) —— 前缀命中则去对应厂商并剥前缀，否则回退默认。"""
        if _PREFIX_SEP in model:
            prefix, _, rest = model.partition(_PREFIX_SEP)
            provider = self._providers.get(prefix)
            if provider is not None and rest:
                return provider, rest
        return self._default, model

    async def complete(self, request: LLMRequest) -> LLMResponse:
        provider, model = self._route(request.model)
        if model != request.model:
            request = replace(request, model=model)
        return await provider.complete(request)

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        provider, model = self._route(request.model)
        if model != request.model:
            request = replace(request, model=model)
        async for chunk in provider.stream(request):
            yield chunk

    async def close(self) -> None:
        """Close the default + every vendor provider's HTTP client (best-effort).

        路由器作为【回合级 llm】由 pipeline 持有（``build_router_around`` 每回合包住当回合
        的默认 provider + 厂商 provider），故 pipeline 的 ``await llm.close()`` 经此一并释放
        默认与所有厂商 client——默认 provider 不再由别处单独关闭（其所有权已移交路由器），
        避免泄漏 httpx 连接。与 ``DeepSeekProvider.close`` / ``OpenAICompatibleProvider.close``
        同名，故路由器可无差别替换原 provider 作为回合 llm。"""
        for provider in (self._default, *self._providers.values()):
            close = getattr(provider, "close", None)
            if close is None:
                continue
            try:
                await close()
            except Exception as e:  # noqa: BLE001 — 关闭失败不致命
                logger.warning("llm.router.close_failed", error=str(e))
