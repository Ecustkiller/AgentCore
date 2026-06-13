"""Model configuration and ModelTier mapping.

Central place for all LLM model settings. Derived from DeepSeek V4 API constraints
documented in .cursor/rules/llm.mdc.
"""

from dataclasses import dataclass
from typing import Literal

from agentcore.core.types import ModelTier


@dataclass(frozen=True)
class ModelConfig:
    """Configuration for a specific model usage scenario."""

    model: str
    thinking: bool = True
    reasoning_effort: Literal["high", "max"] | None = "high"
    temperature: float = 0.7
    max_tokens: int | None = None


# DeepSeek V4 model identifiers
DEEPSEEK_V4_FLASH = "deepseek-v4-flash"
DEEPSEEK_V4_PRO = "deepseek-v4-pro"


@dataclass(frozen=True)
class ModelMapping:
    """ModelTier -> concrete model mapping. Override per deployment."""

    fast: str = DEEPSEEK_V4_FLASH
    standard: str = DEEPSEEK_V4_FLASH
    strong: str = DEEPSEEK_V4_PRO


DEFAULT_MODEL_MAPPING = ModelMapping()


# Role-based model configurations (per llm.mdc rules)
MODEL_CONFIGS: dict[str, ModelConfig] = {
    "orchestrator": ModelConfig(
        model=DEEPSEEK_V4_FLASH,
        thinking=True,
        reasoning_effort="max",
        temperature=0.3,
    ),
    "agent_fast": ModelConfig(
        model=DEEPSEEK_V4_FLASH,
        thinking=False,
        reasoning_effort=None,
        temperature=0.7,
    ),
    "agent_standard": ModelConfig(
        model=DEEPSEEK_V4_FLASH,
        thinking=True,
        reasoning_effort="high",
        temperature=0.7,
    ),
    "agent_strong": ModelConfig(
        model=DEEPSEEK_V4_PRO,
        thinking=True,
        reasoning_effort="high",
        temperature=0.7,
    ),
    "memory": ModelConfig(
        model=DEEPSEEK_V4_FLASH,
        thinking=False,
        reasoning_effort=None,
        temperature=0.3,
    ),
}


def resolve_model_for_tier(tier: ModelTier, mapping: ModelMapping | None = None) -> str:
    """Resolve a ModelTier to a concrete model name."""
    m = mapping or DEFAULT_MODEL_MAPPING
    return getattr(m, tier.value)


def get_model_config(role: str) -> ModelConfig:
    """Get model config for a given role, falling back to agent_standard."""
    return MODEL_CONFIGS.get(role, MODEL_CONFIGS["agent_standard"])
