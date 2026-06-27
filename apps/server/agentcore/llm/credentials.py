"""Per-turn LLM credential carrier and cloud-proxy HTTP headers.

Kept DB/security-free so the desktop sidecar can import :class:`LLMCredentials`
and the inference header constants without dragging in sqlalchemy, KeyEncryptor,
or JWT/password primitives. Server-side BYOK resolution lives in ``llm/byok.py``.
"""

from __future__ import annotations

from dataclasses import dataclass

# HTTP header a sidecar stamps on its cloud-proxy LLM calls so the /v1/inference
# proxy can attribute spend to the conversation (双模式工作区 §一.1 / Slice 4a).
INFERENCE_CONVERSATION_HEADER = "X-AgentCore-Conversation"
# HTTP header carrying the local turn's trace_id on every cloud-proxy LLM call.
INFERENCE_TRACE_HEADER = "X-AgentCore-Trace"


@dataclass(frozen=True)
class LLMCredentials:
    """A resolved BYOK key plus the server-fixed endpoint for one turn."""

    api_key: str
    base_url: str
    # Optional per-turn HTTP headers the provider sends upstream. The sidecar uses
    # this to stamp the conversation id on its cloud-proxy LLM calls (Slice 4a).
    extra_headers: dict[str, str] | None = None
