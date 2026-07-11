"""Scenario profiles: inference params per usage scenario (model resolved separately)."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.llm.credentials import LLMCredentials

from agentcore.core.types import ModelTier
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest

# Platform model id constants (eval / pricing / migration defaults).
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
    # None = provider default (DeepSeek V4 → thinking on). False = force off for
    # background one-shots (title / memory / …) — required so a 64-token title
    # budget is not eaten by reasoning_content (DeepSeek-V4-API参考 §七.2).
    thinking: bool | None = None


PROFILES: dict[str, ProfileParams] = {
    "chat": ProfileParams(temperature=0.7, max_rounds=16),
    "agent.fast": ProfileParams(temperature=0.7, max_rounds=8),
    "agent.strong": ProfileParams(temperature=0.7, max_rounds=28),
    "memory": ProfileParams(temperature=0.3, max_rounds=1, thinking=False),
    "compaction": ProfileParams(temperature=0.3, max_rounds=1, thinking=False),
    "file.rewrite": ProfileParams(temperature=0.4, max_rounds=1, thinking=False),
    "title": ProfileParams(temperature=0.3, max_tokens=64, max_rounds=1, thinking=False),
    "followups": ProfileParams(temperature=0.5, max_tokens=256, max_rounds=1, thinking=False),
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
        thinking=profile.thinking,
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


def turn_profiles_for_turn(
    profile_set: TurnProfiles | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> TurnProfiles:
    """Resolve turn profiles for a pipeline/sidecar run.

    BYOK and inference-proxy turns must not inherit ``settings.platform_model`` when
    the caller did not supply an explicit profile set — the upstream model comes from
    the user's credentials (direct BYOK) or from the proxy's server-side resolution.
    """
    if profile_set is not None:
        return profile_set
    if llm_credentials is not None:
        from agentcore.llm.resolve import resolve_turn_model

        return default_turn_profiles(model=resolve_turn_model(llm_credentials))
    return default_turn_profiles()

