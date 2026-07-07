"""Unified model + credential resolution for every LLM call site."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import PLATFORM_MODEL_FLASH

logger = get_logger(__name__)

ProviderPurpose = Literal["user_facing", "platform_internal"]
ModelPurpose = str  # chat | title | memory | compaction | file.rewrite | followups | ...

__all__ = [
    "ModelConfig",
    "ProviderPurpose",
    "platform_llm_credentials",
    "resolve_credentials",
    "resolve_model_config",
    "resolve_turn_model",
    "resolve_user_llm_credentials",
]


@dataclass(frozen=True)
class ModelConfig:
    model: str
    base_url: str
    api_key: str
    source: Literal["platform", "byok"]
    purpose: str


def _encryptor():
    from agentcore.security.keys import KeyEncryptor

    if not settings.encryption_key:
        return None
    return KeyEncryptor(settings.encryption_key)


def _model_for_purpose(purpose: str, *, billing_mode: str, byok_default: str | None) -> str:
    # Per-purpose override hook — today all purposes share platform_model.
    _ = purpose
    if billing_mode == "platform":
        return settings.platform_model
    return byok_default or PLATFORM_MODEL_FLASH


def platform_llm_credentials() -> LLMCredentials | None:
    api_key = settings.platform_api_key.strip()
    if not api_key:
        return None
    return LLMCredentials(
        api_key=api_key,
        base_url=settings.platform_base_url,
        default_model=settings.platform_model,
    )


async def resolve_user_llm_credentials(
    session: AsyncSession, user_id: str
) -> LLMCredentials | None:
    from agentcore.db.repositories import UserLlmKeyRepository

    row = await UserLlmKeyRepository(session).get_by_user_id(user_id)
    if row is None or not row.api_key_enc:
        return None
    enc = _encryptor()
    if enc is None:
        return None
    try:
        api_key = enc.decrypt(row.api_key_enc).decode()
    except Exception as e:
        logger.warning("byok.decrypt_failed", user_id=user_id, error=str(e))
        return None
    return LLMCredentials(
        api_key=api_key,
        base_url=row.base_url or settings.platform_base_url,
        default_model=row.default_model or PLATFORM_MODEL_FLASH,
    )


async def resolve_model_config(
    session: AsyncSession,
    user_id: str,
    purpose: ModelPurpose = "chat",
) -> ModelConfig | None:
    """Resolve full upstream config for one LLM purpose."""
    from agentcore.billing.preference import resolve_effective_billing_mode
    from agentcore.db.repositories import UserRepository

    user = await UserRepository(session).get_by_id(user_id)
    billing_mode = resolve_effective_billing_mode(user)

    if billing_mode == "platform":
        platform = platform_llm_credentials()
        if platform is None:
            return None
        return ModelConfig(
            model=_model_for_purpose(purpose, billing_mode=billing_mode, byok_default=None),
            base_url=platform.base_url,
            api_key=platform.api_key,
            source="platform",
            purpose=purpose,
        )

    platform = platform_llm_credentials()
    if purpose in ("title", "memory", "compaction", "followups") and platform is not None:
        return ModelConfig(
            model=_model_for_purpose(purpose, billing_mode=billing_mode, byok_default=None),
            base_url=platform.base_url,
            api_key=platform.api_key,
            source="platform",
            purpose=purpose,
        )
    creds = await resolve_user_llm_credentials(session, user_id)
    if creds is None:
        if platform is not None:
            return ModelConfig(
                model=_model_for_purpose(purpose, billing_mode=billing_mode, byok_default=None),
                base_url=platform.base_url,
                api_key=platform.api_key,
                source="platform",
                purpose=purpose,
            )
        return None
    return ModelConfig(
        model=_model_for_purpose(purpose, billing_mode=billing_mode, byok_default=creds.default_model),
        base_url=creds.base_url,
        api_key=creds.api_key,
        source="byok",
        purpose=purpose,
    )


async def resolve_credentials(
    session: AsyncSession,
    user_id: str,
    purpose: ProviderPurpose = "user_facing",
) -> LLMCredentials | None:
    """Legacy credential carrier for factory / route preflight."""
    scenario = "chat" if purpose == "user_facing" else "title"
    cfg = await resolve_model_config(session, user_id, scenario)
    if cfg is None:
        return None
    return LLMCredentials(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        default_model=cfg.model,
    )


def resolve_turn_model(credentials: LLMCredentials | None) -> str:
    if credentials is not None:
        return credentials.default_model
    return settings.platform_model
