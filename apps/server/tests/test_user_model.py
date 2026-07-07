"""Tests for turn model resolution (llm/resolve.py)."""

from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH, default_turn_profiles
from agentcore.llm.resolve import resolve_turn_model


def test_resolve_turn_model_from_credentials():
    creds = LLMCredentials(
        api_key="sk-test", base_url="https://api.openai.com/v1", default_model="gpt-4o"
    )
    assert resolve_turn_model(creds) == "gpt-4o"


def test_resolve_turn_model_platform_fallback(monkeypatch):
    monkeypatch.setattr("agentcore.llm.resolve.settings.platform_api_key", "sk")
    monkeypatch.setattr("agentcore.llm.resolve.settings.platform_model", DEEPSEEK_V4_FLASH)
    assert resolve_turn_model(None) == DEEPSEEK_V4_FLASH


def test_default_turn_profiles_carries_model():
    ps = default_turn_profiles(model="kimi-k2.5")
    assert ps.model == "kimi-k2.5"
    assert ps.get("chat").max_rounds == 16
