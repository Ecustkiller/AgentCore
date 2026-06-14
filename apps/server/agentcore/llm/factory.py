"""LLM provider assembly.

The single place that builds a configured ``LLMProvider`` from app settings, so
API key / base URL wiring lives in one spot rather than being repeated at every
call site (chat pipeline, conversation service). MVP wires DeepSeek; swapping or
routing providers happens here without touching callers.
"""

from agentcore.config import settings
from agentcore.llm.deepseek import DeepSeekProvider


def build_provider() -> DeepSeekProvider:
    """Construct the configured LLM provider (MVP: DeepSeek)."""
    return DeepSeekProvider(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
