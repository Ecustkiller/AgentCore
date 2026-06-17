"""LLM provider assembly.

The single place that builds a configured ``LLMProvider``, so API key / base URL
wiring lives in one spot rather than being repeated at every call site (chat
pipeline, conversation service, memory consolidation).

BYOK (config.billing_mode): the caller resolves the user's own credentials
(llm/byok.py) and passes them in, so the turn runs on the user's DeepSeek key.
When no credentials are given the global server key is used — the platform-pays
fallback, kept behind the billing-mode switch (empty in the BYOK beta).
"""

from agentcore.config import settings
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.deepseek import DeepSeekProvider


def build_provider(credentials: LLMCredentials | None = None) -> DeepSeekProvider:
    """Construct the LLM provider for a turn.

    ``credentials`` (resolved per-user in BYOK mode) override the API key + base
    URL so the turn runs on the user's own DeepSeek quota; ``None`` falls back to
    the global server config (platform mode / background fallback).
    """
    if credentials is not None:
        return DeepSeekProvider(
            api_key=credentials.api_key,
            base_url=credentials.base_url,
            extra_headers=credentials.extra_headers,
        )
    return DeepSeekProvider(
        api_key=settings.deepseek_api_key,
        base_url=settings.deepseek_base_url,
    )
