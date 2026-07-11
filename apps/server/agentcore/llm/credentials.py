"""Per-turn LLM credential carrier and cloud-proxy HTTP headers.

Attribution headers let the inference proxy stamp each proxied LLM call with
the sidecar worker's run tree (run / agent / role / persona) so per-call detail
rows and per-run aggregates stay isomorphic with in-process cloud turns.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from agentcore.llm.profiles import PLATFORM_MODEL_FLASH

INFERENCE_CONVERSATION_HEADER = "X-AgentCore-Conversation"
INFERENCE_TRACE_HEADER = "X-AgentCore-Trace"
INFERENCE_MESSAGE_HEADER = "X-AgentCore-Message"
INFERENCE_RUN_HEADER = "X-AgentCore-Run"
INFERENCE_PARENT_RUN_HEADER = "X-AgentCore-Parent-Run"
INFERENCE_AGENT_HEADER = "X-AgentCore-Agent"
INFERENCE_ROLE_HEADER = "X-AgentCore-Role"
INFERENCE_PERSONA_HEADER = "X-AgentCore-Persona"
INFERENCE_CALL_HEADER = "X-AgentCore-Call"


@dataclass(frozen=True)
class LLMCredentials:
    api_key: str
    base_url: str
    default_model: str = field(default=PLATFORM_MODEL_FLASH)
    extra_headers: dict[str, str] | None = None
