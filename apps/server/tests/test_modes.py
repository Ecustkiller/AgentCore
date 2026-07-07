"""Unit tests for TurnProfiles (llm/profiles.py)."""

from agentcore.core.types import ModelTier
from agentcore.llm.profiles import PROFILES, TurnProfiles, default_turn_profiles, get_profile


def test_default_turn_profiles_uses_platform_model(monkeypatch):
    monkeypatch.setattr("agentcore.config.settings.platform_model", "gpt-5")
    ps = default_turn_profiles()
    assert ps.model == "gpt-5"
    assert ps.get("chat").temperature == PROFILES["chat"].temperature


def test_turn_profiles_agent_accepts_model_tier_enum():
    ps = default_turn_profiles(model="test-model")
    assert ps.agent(ModelTier.FAST).max_rounds == PROFILES["agent.fast"].max_rounds
    assert ps.agent(ModelTier.STRONG).max_rounds == PROFILES["agent.strong"].max_rounds


def test_turn_profiles_model_overrides():
    ps = TurnProfiles(model="base", model_overrides={"chat": "pro-model"})
    assert ps.model_for("chat") == "pro-model"
    assert ps.model_for("memory") == "base"


def test_get_profile_falls_back_to_chat():
    assert get_profile("unknown").name == "chat"
