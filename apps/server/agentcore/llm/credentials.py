"""Per-turn LLM credential carrier and cloud-proxy HTTP headers."""

from __future__ import annotations

from dataclasses import dataclass, field

from agentcore.llm.profiles import PLATFORM_MODEL_FLASH

INFERENCE_CONVERSATION_HEADER = "X-AgentCore-Conversation"
INFERENCE_TRACE_HEADER = "X-AgentCore-Trace"
INFERENCE_MESSAGE_HEADER = "X-AgentCore-Message"


@dataclass(frozen=True)
class LLMCredentials:
    api_key: str
    base_url: str
    default_model: str = field(default=PLATFORM_MODEL_FLASH)
    extra_headers: dict[str, str] | None = None
