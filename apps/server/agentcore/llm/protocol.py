"""LLMProvider protocol and core data types.

Defines the unified abstraction for LLM calls. MVP only implements DeepSeekProvider.
All orchestrator, agent runtime, and memory modules depend on this protocol.
"""

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol


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
    # Usage scenario (profile name: chat / agent.fast / agent.strong / memory /
    # title), stamped by build_request. Pure observability — rides into the
    # llm.call log so spend/latency/quality attribute per scenario, not an API field.
    scenario: str = "chat"


@dataclass
class TokenUsage:
    """Token consumption statistics.

    ``input_tokens`` is the whole prompt; DeepSeek pre-splits it into
    ``cache_hit_tokens`` + ``cache_miss_tokens`` (a cache hit is ~50× cheaper),
    so pricing must keep the split. ``output_tokens`` already includes
    ``reasoning_tokens`` (reasoning is a billed subset of completion).
    """

    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: "TokenUsage") -> "TokenUsage":
        """Field-wise sum, for folding per-round / per-run usage into a total."""
        return TokenUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            cache_hit_tokens=self.cache_hit_tokens + other.cache_hit_tokens,
            cache_miss_tokens=self.cache_miss_tokens + other.cache_miss_tokens,
        )

    def as_dict(self) -> dict[str, int]:
        """Short-key ledger form ({input, output, reasoning, cache_hit,
        cache_miss}) — the shape stored in ``RunState.usage`` and the
        ``cost_events.tokens`` column."""
        return {
            "input": self.input_tokens,
            "output": self.output_tokens,
            "reasoning": self.reasoning_tokens,
            "cache_hit": self.cache_hit_tokens,
            "cache_miss": self.cache_miss_tokens,
        }

    @classmethod
    def from_usage_dict(cls, usage: Mapping[str, int]) -> "TokenUsage":
        """Inverse of :meth:`as_dict` — rebuild a TokenUsage from the short-key
        ledger form ({input, output, reasoning, cache_hit, cache_miss}) carried on
        ``RunState.usage`` and accumulated on the delegate / revise tools. Missing
        keys default to 0, so a partial dict (or ``{}``) is safe. The single seam
        for "short-key usage dict → TokenUsage", so the pipeline folds the captain
        / delegated / revised usage without hand-rebuilding the struct three times.
        """
        return cls(
            input_tokens=usage.get("input", 0),
            output_tokens=usage.get("output", 0),
            reasoning_tokens=usage.get("reasoning", 0),
            cache_hit_tokens=usage.get("cache_hit", 0),
            cache_miss_tokens=usage.get("cache_miss", 0),
        )


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
