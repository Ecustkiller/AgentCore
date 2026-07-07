"""ProviderRouter — dispatch LLM calls by ``provider/model`` prefix."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import replace

from agentcore.core.logging import get_logger
from agentcore.llm.provider.protocol import LLMChunk, LLMProvider, LLMRequest, LLMResponse

logger = get_logger(__name__)

_PREFIX_SEP = "/"


class ProviderRouter:
    def __init__(
        self, *, default: LLMProvider, providers: dict[str, LLMProvider] | None = None
    ) -> None:
        self._default = default
        self._providers: dict[str, LLMProvider] = dict(providers or {})

    @property
    def available_prefixes(self) -> frozenset[str]:
        return frozenset(self._providers)

    def _route(self, model: str) -> tuple[LLMProvider, str]:
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
        for provider in (self._default, *self._providers.values()):
            close = getattr(provider, "close", None)
            if close is None:
                continue
            try:
                await close()
            except Exception as e:  # noqa: BLE001
                logger.warning("llm.router.close_failed", error=str(e))
