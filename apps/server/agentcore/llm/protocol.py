"""LLMProvider protocol and core data types.

Defines the unified abstraction for LLM calls. MVP only implements DeepSeekProvider.
All orchestrator, agent runtime, and memory modules depend on this protocol.
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Literal, Protocol

from agentcore.core.types import ModelTier


@dataclass
class ToolCallFunction:
    """Function call within a tool call."""

    name: str
    arguments: str  # JSON string


@dataclass
class ToolCall:
    """LLM-issued tool call request."""

    id: str
    type: Literal["function"] = "function"
    function: ToolCallFunction = field(default_factory=lambda: ToolCallFunction("", ""))


@dataclass
class ToolCallDelta:
    """Streaming incremental tool call."""

    index: int
    id: str | None = None
    function_name: str | None = None
    arguments_delta: str | None = None


@dataclass
class LLMMessage:
    """A single message in the conversation."""

    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    reasoning_content: str | None = None


@dataclass
class LLMRequest:
    """Request to the LLM provider."""

    messages: list[LLMMessage]
    model: str
    temperature: float = 0.7
    max_tokens: int | None = None
    tools: list[dict] | None = None  # OpenAI-compatible tool definitions
    tool_choice: Literal["auto", "none", "required"] = "auto"
    stream: bool = True
    thinking: bool | None = None  # None = use model default
    reasoning_effort: Literal["high", "max"] | None = None


@dataclass
class TokenUsage:
    """Token consumption statistics."""

    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class LLMResponse:
    """Complete (non-streaming) LLM response."""

    content: str = ""
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] | None = None
    usage: TokenUsage = field(default_factory=TokenUsage)
    finish_reason: Literal["stop", "tool_calls", "length", "content_filter"] = "stop"
    model: str = ""
    latency_ms: int = 0


@dataclass
class LLMChunk:
    """A single chunk from streaming output."""

    delta_content: str | None = None
    delta_reasoning: str | None = None
    delta_tool_calls: list[ToolCallDelta] | None = None
    finish_reason: str | None = None
    usage: TokenUsage | None = None


class LLMProvider(Protocol):
    """Unified abstraction for LLM calls."""

    async def complete(self, request: LLMRequest) -> LLMResponse:
        """Non-streaming call. Returns the full response."""
        ...

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]:
        """Streaming call. Yields chunks as they arrive."""
        ...

    def resolve_model(self, tier: ModelTier) -> str:
        """Map a ModelTier preference to a concrete model identifier."""
        ...
