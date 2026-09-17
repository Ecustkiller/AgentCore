"""Per-request protocol dispatch: one Zen/Go key, two HTTP APIs.

``/chat/completions`` stays the default. Known ``/messages`` ids on OpenCode
endpoints go to :class:`AnthropicMessagesProvider` and are selectable in the
BYOK catalog. Platform allowlist rows for the same ids stay grey.
Thinking blocks with signatures round-trip on ``LLMMessage.thinking_blocks``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from agentcore.llm.byok_provider_presets import uses_anthropic_messages_wire
from agentcore.llm.provider.anthropic import AnthropicMessagesProvider
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMChunk, LLMRequest, LLMResponse


class ProtocolDispatchProvider:
    """Leaf that picks chat/completions vs /messages from ``request.model``."""

    def __init__(
        self,
        *,
        name: str,
        api_key: str,
        base_url: str,
        extra_headers: dict[str, str] | None = None,
        display_name: str | None = None,
    ) -> None:
        self._name = name
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._extra_headers = dict(extra_headers) if extra_headers else None
        self._display_name = display_name
        self._openai = OpenAICompatibleProvider(
            name=name,
            api_key=api_key,
            base_url=base_url,
            extra_headers=extra_headers,
            display_name=display_name,
        )
        self._anthropic: AnthropicMessagesProvider | None = None

    def _kwargs(self) -> dict:
        return {
            "name": self._name,
            "api_key": self._api_key,
            "base_url": self._base_url,
            "extra_headers": self._extra_headers,
            "display_name": self._display_name,
        }

    def _leaf(self, model: str):
        if uses_anthropic_messages_wire(model, self._base_url):
            if self._anthropic is None:
                self._anthropic = AnthropicMessagesProvider(**self._kwargs())
            return self._anthropic
        return self._openai

    @property
    def name(self) -> str:
        return self._openai.name

    @property
    def display_name(self) -> str:
        return self._openai.display_name

    @property
    def base_url(self) -> str:
        return self._openai.base_url

    def clone(self) -> ProtocolDispatchProvider:
        return ProtocolDispatchProvider(**self._kwargs())

    async def complete(self, request: LLMRequest) -> LLMResponse:
        return await self._leaf(request.model).complete(request)

    def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        return self._leaf(request.model).stream(request)

    async def probe(self, *, model: str) -> None:
        await self._leaf(model).probe(model=model)

    async def probe_tools(self, *, model: str) -> bool | None:
        probe_tools = getattr(self._leaf(model), "probe_tools", None)
        if probe_tools is None:
            return None
        return await probe_tools(model=model)

    async def list_models(self) -> list[str]:
        return await self._openai.list_models()

    async def close(self) -> None:
        await self._openai.close()
        if self._anthropic is not None:
            await self._anthropic.close()


def build_credential_leaf(
    *,
    name: str,
    api_key: str,
    base_url: str,
    extra_headers: dict[str, str] | None = None,
    display_name: str | None = None,
) -> ProtocolDispatchProvider:
    """BYOK / platform-member leaf: dispatch chat vs /messages on the same key."""
    return ProtocolDispatchProvider(
        name=name,
        api_key=api_key,
        base_url=base_url,
        extra_headers=extra_headers,
        display_name=display_name,
    )
