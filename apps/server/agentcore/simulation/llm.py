"""SimAgent LLM resolution — DeepSeek via platform, BYOK, or eval env."""

from __future__ import annotations

import os
from enum import StrEnum

from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.llm.profiles import PLATFORM_MODEL_FLASH
from agentcore.llm.provider.protocol import LLMProvider
from agentcore.llm.resolve import (
    ModelConfig,
    platform_llm_credentials,
    resolve_user_llm_credentials,
)


class SimModelTier(StrEnum):
    """Decision importance tier for model routing (BE-13)."""

    ROUTINE = "routine"
    CRITICAL = "critical"


class SimModelRoutingConfig(BaseModel):
    """Per-run model routing manifest; M2 uses the same model for all tiers."""

    routine_model: str
    critical_model: str = Field(description="Reserved for key decisions; M2 aliases routine_model")


def default_routing_config(base_model: str) -> SimModelRoutingConfig:
    return SimModelRoutingConfig(routine_model=base_model, critical_model=base_model)


class SimModelRouter:
    """Resolve which model to use for a given decision tier."""

    def __init__(self, config: SimModelRoutingConfig):
        self._config = config

    @classmethod
    def from_run_config(cls, run_config: dict | None, *, fallback: str) -> SimModelRouter:
        raw = (run_config or {}).get("model_routing") or {}
        if raw.get("routine_model"):
            cfg = SimModelRoutingConfig.model_validate(raw)
        else:
            cfg = default_routing_config(fallback)
        return cls(cfg)

    @property
    def config(self) -> SimModelRoutingConfig:
        return self._config

    def resolve(self, tier: SimModelTier = SimModelTier.ROUTINE) -> str:
        if tier == SimModelTier.CRITICAL:
            return self._config.critical_model
        return self._config.routine_model

    def to_manifest(self) -> dict:
        return {"model_routing": self._config.model_dump()}


class SimLlmNotConfigured(Exception):
    """No usable DeepSeek credentials for simulation."""


def is_deepseek_upstream(base_url: str) -> bool:
    return "deepseek.com" in (base_url or "").lower()


def sim_native_tools(base_url: str) -> bool:
    """DeepSeek supports native tool calling; Codex proxy needs text-JSON fallback."""
    return is_deepseek_upstream(base_url)


def _eval_credentials() -> LLMCredentials | None:
    key = os.environ.get("EVAL_DEEPSEEK_API_KEY", "").strip()
    if not key:
        return None
    base = os.environ.get("EVAL_DEEPSEEK_BASE_URL", "").strip() or "https://api.deepseek.com"
    model = os.environ.get("EVAL_DEEPSEEK_MODEL", "").strip() or PLATFORM_MODEL_FLASH
    return LLMCredentials(api_key=key, base_url=base, default_model=model)


def _platform_deepseek() -> LLMCredentials | None:
    platform = platform_llm_credentials()
    if platform is None or not is_deepseek_upstream(platform.base_url):
        return None
    return platform


def _to_model_config(creds: LLMCredentials, *, source: str) -> ModelConfig:
    return ModelConfig(
        model=creds.default_model or PLATFORM_MODEL_FLASH,
        base_url=creds.base_url,
        api_key=creds.api_key,
        source=source,  # type: ignore[arg-type]
        purpose="sim.town",
    )


async def resolve_sim_model_config(
    session: AsyncSession | None,
    user_id: str | None,
) -> ModelConfig:
    """Resolve DeepSeek for sim: platform → user BYOK → EVAL_DEEPSEEK_*."""
    platform = _platform_deepseek()
    if platform is not None:
        return _to_model_config(platform, source="platform")

    if session is not None and user_id:
        byok = await resolve_user_llm_credentials(session, user_id)
        if byok is not None and is_deepseek_upstream(byok.base_url):
            return _to_model_config(byok, source="byok")

    eval_creds = _eval_credentials()
    if eval_creds is not None:
        return _to_model_config(eval_creds, source="platform")

    raise SimLlmNotConfigured(
        "模拟决策需要 DeepSeek：请在 .env 配置 PLATFORM_* 指向 api.deepseek.com，"
        "或在「设置·模型配置」保存 DeepSeek Key，或导出 EVAL_DEEPSEEK_API_KEY。"
    )


async def build_sim_provider(
    session: AsyncSession | None,
    user_id: str | None,
) -> tuple[LLMProvider, ModelConfig]:
    cfg = await resolve_sim_model_config(session, user_id)
    creds = LLMCredentials(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        default_model=cfg.model,
    )
    return build_provider(creds), cfg


def resolve_text_mode(
    base_url: str,
    *,
    override: bool | None,
) -> bool:
    if override is not None:
        return override
    return not sim_native_tools(base_url)
