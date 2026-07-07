"""Scenario profiles: inference params per usage scenario (model resolved separately)."""

from __future__ import annotations

from dataclasses import dataclass, field, replace

from agentcore.core.types import ModelTier
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest

# Legacy model id constants (eval / pricing / migration defaults).
PLATFORM_MODEL_FLASH = "deepseek-v4-flash"
PLATFORM_MODEL_PRO = "deepseek-v4-pro"
DEEPSEEK_V4_FLASH = PLATFORM_MODEL_FLASH
DEEPSEEK_V4_PRO = PLATFORM_MODEL_PRO


@dataclass(frozen=True)
class ProfileParams:
    """Inference params for one usage scenario (no model — use ModelConfig.model)."""

    temperature: float = 0.7
    max_tokens: int | None = None
    max_rounds: int = 16
    name: str = ""


PROFILES: dict[str, ProfileParams] = {
    "chat": ProfileParams(temperature=0.7, max_rounds=16),
    "agent.fast": ProfileParams(temperature=0.7, max_rounds=8),
    "agent.strong": ProfileParams(temperature=0.7, max_rounds=28),
    "memory": ProfileParams(temperature=0.3, max_rounds=1),
    "compaction": ProfileParams(temperature=0.3, max_rounds=1),
    "file.rewrite": ProfileParams(temperature=0.4, max_rounds=1),
    "title": ProfileParams(temperature=0.3, max_tokens=64, max_rounds=1),
    "followups": ProfileParams(temperature=0.5, max_tokens=256, max_rounds=1),
}

_DEFAULT_PROFILE = "chat"


def get_profile(name: str) -> ProfileParams:
    resolved = name if name in PROFILES else _DEFAULT_PROFILE
    return replace(PROFILES[resolved], name=resolved)


def agent_profile(preference: ModelTier | str) -> ProfileParams:
    pref = preference.value if isinstance(preference, ModelTier) else str(preference)
    return get_profile(f"agent.{pref}")


def build_request(
    profile: ProfileParams,
    messages: list[LLMMessage],
    *,
    tools: list[dict] | None = None,
    tool_choice: str = "auto",
    stream: bool = True,
    model: str,
) -> LLMRequest:
    return LLMRequest(
        messages=messages,
        model=model,
        temperature=profile.temperature,
        max_tokens=profile.max_tokens,
        tools=tools,
        tool_choice=tool_choice if tools else "none",
        stream=stream,
        scenario=profile.name or _DEFAULT_PROFILE,
    )


@dataclass(frozen=True)
class TurnProfiles:
    """Turn-level resolved model + static scenario params (replaces ProfileSet)."""

    model: str
    model_overrides: dict[str, str] = field(default_factory=dict)

    def model_for(self, profile_name: str) -> str:
        return self.model_overrides.get(profile_name, self.model)

    def get(self, name: str) -> ProfileParams:
        return get_profile(name)

    def agent(self, preference: ModelTier | str) -> ProfileParams:
        return agent_profile(preference)


def default_turn_profiles(*, model: str | None = None) -> TurnProfiles:
    from agentcore.config import settings

    return TurnProfiles(model=model or settings.platform_model)


# Backward-compat alias during migration.
ModelProfile = ProfileParams
ProfileSet = TurnProfiles
default_profile_set = default_turn_profiles
