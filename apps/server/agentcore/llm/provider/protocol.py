"""LLMProvider protocol and core data types."""

from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Literal, Protocol


@dataclass
class ToolCallFunction:
    name: str
    arguments: str


@dataclass
class ToolCall:
    id: str
    type: Literal["function"] = "function"
    function: ToolCallFunction = field(default_factory=lambda: ToolCallFunction("", ""))


@dataclass
class ToolCallDelta:
    index: int
    id: str | None = None
    function_name: str | None = None
    arguments_delta: str | None = None


@dataclass
class LLMMessage:
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    reasoning_content: str | None = None


@dataclass
class LLMRequest:
    messages: list[LLMMessage]
    model: str
    temperature: float = 0.7
    max_tokens: int | None = None
    tools: list[dict] | None = None
    tool_choice: Literal["auto", "none", "required"] = "auto"
    stream: bool = True
    scenario: str = "chat"
    # None = omit (provider default). False/True → DeepSeek V4 ``thinking.type``.
    thinking: bool | None = None


@dataclass
class TokenUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: "TokenUsage") -> "TokenUsage":
        return TokenUsage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            reasoning_tokens=self.reasoning_tokens + other.reasoning_tokens,
            cache_hit_tokens=self.cache_hit_tokens + other.cache_hit_tokens,
            cache_miss_tokens=self.cache_miss_tokens + other.cache_miss_tokens,
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "input": self.input_tokens,
            "output": self.output_tokens,
            "reasoning": self.reasoning_tokens,
            "cache_hit": self.cache_hit_tokens,
            "cache_miss": self.cache_miss_tokens,
        }

    @classmethod
    def from_usage_dict(cls, usage: Mapping[str, int]) -> "TokenUsage":
        return cls(
            input_tokens=usage.get("input", 0),
            output_tokens=usage.get("output", 0),
            reasoning_tokens=usage.get("reasoning", 0),
            cache_hit_tokens=usage.get("cache_hit", 0),
            cache_miss_tokens=usage.get("cache_miss", 0),
        )


@dataclass
class LLMResponse:
    content: str = ""
    reasoning_content: str | None = None
    tool_calls: list[ToolCall] | None = None
    usage: TokenUsage = field(default_factory=TokenUsage)
    finish_reason: Literal["stop", "tool_calls", "length", "content_filter"] = "stop"
    model: str = ""
    latency_ms: int = 0
    empty_diagnosis: str | None = None
    empty_raw_preview: str | None = None


@dataclass
class LLMChunk:
    delta_content: str | None = None
    delta_reasoning: str | None = None
    delta_tool_calls: list[ToolCallDelta] | None = None
    finish_reason: str | None = None
    usage: TokenUsage | None = None
    empty_diagnosis: str | None = None
    empty_raw_preview: str | None = None
    # Control signals (mutually exclusive with normal deltas when set):
    # stream_reset — transparent pre-commit retry; consumer must drop ephemeral
    #   reasoning and reset the live view before the next attempt's chunks.
    # aborted — post-commit disconnect; consumer keeps the partial and must not
    #   treat the stream as a hard raise/discard.
    stream_reset: bool = False
    aborted: bool = False


class LLMProvider(Protocol):
    async def complete(self, request: LLMRequest) -> LLMResponse: ...

    async def stream(self, request: LLMRequest) -> AsyncIterator[LLMChunk]: ...
