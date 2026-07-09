"""Diagnostic LLM window projection schemas (§8.3 window_from_journal wire shape)."""

from typing import Literal

from pydantic import BaseModel, Field


class LlmWindowToolCallFunction(BaseModel):
    name: str
    arguments: str


class LlmWindowToolCall(BaseModel):
    id: str
    type: Literal["function"] = "function"
    function: LlmWindowToolCallFunction


class LlmWindowMessageLine(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str | None = None
    tool_calls: list[LlmWindowToolCall] | None = None
    tool_call_id: str | None = None
    reasoning_content: str | None = None


class RunLlmWindowResponse(BaseModel):
    """One run's folded LLM input window for a turn (diagnostic replay)."""

    run_id: str
    available: bool = Field(
        description="False when the journal lacks execution facts to fold a window."
    )
    messages: list[LlmWindowMessageLine] = Field(default_factory=list)
