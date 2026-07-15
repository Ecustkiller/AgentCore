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

_BACKGROUND_PURPOSES = frozenset({"title", "memory", "compaction", "followups"})

__all__ = [
    "ModelConfig",
    "ProviderPurpose",
    "platform_llm_credentials",
    "resolve_credentials",
    "resolve_model_config",
    "resolve_turn_model",
    "resolve_user_chat_model",
    "resolve_user_llm_credentials",
]


@dataclass(frozen=True)
class ModelConfig:
    model: str
    base_url: str
    api_key: str
    source: Literal["platform", "byok"]
    purpose: str
    price_cache_hit: str | None = None
    price_cache_miss: str | None = None
    price_output: str | None = None
    background_model: str | None = None


def _encryptor():
    from agentcore.security.keys import KeyEncryptor

    if not settings.encryption_key:
        return None
    return KeyEncryptor(settings.encryption_key)


def _model_for_purpose(
    purpose: str,
    *,
    chat_model: str,
    user_background_model: str | None = None,
) -> str:
    """Resolve model name for ``purpose``; background prefers background_model."""
    if purpose not in _BACKGROUND_PURPOSES:
        return chat_model
    if user_background_model and user_background_model.strip():
        return user_background_model.strip()
    platform_bg = (settings.platform_background_model or "").strip()
    if platform_bg:
        return platform_bg
    return chat_model


def platform_llm_credentials() -> LLMCredentials | None:
    api_key = settings.platform_api_key.strip()
    if not api_key:
        return None
    return LLMCredentials(
        api_key=api_key,
        base_url=settings.platform_base_url,
        default_model=settings.platform_model,
        source="platform",
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
        source="user",
        price_cache_hit=getattr(row, "price_cache_hit", None),
        price_cache_miss=getattr(row, "price_cache_miss", None),
        price_output=getattr(row, "price_output", None),
        background_model=getattr(row, "background_model", None),
    )


async def resolve_model_config(
    session: AsyncSession,
    user_id: str,
    purpose: ModelPurpose = "chat",
) -> ModelConfig | None:
    """Resolve full upstream config for one LLM purpose.

    SELECTION / ADVISORY ONLY — never an authorization path (01 F10). For a BYOK user
    with no key this deliberately FALLS BACK to the platform model so token advisory
    model / turn-profile selection still resolves a NAME. That diverges on purpose from
    the billing gate (``preflight_llm_credentials``), which 402s the same keyless-BYOK
    case when free tier is off: the gate is the single authorization choke point for
    building an authed provider. Callers MUST NOT use this result to run a BYOK user's
    turn on the platform key — today's consumers (``resolve_turn_model`` /
    ``resolve_user_chat_model``) only read the model name.

    D6: background purposes (title/memory/compaction/followups) prefer the user's
    key when present; only keyless users fall through to the platform key.
    Background *model* prefers ``background_model`` / ``platform_background_model``.
    """
    from agentcore.billing.preference import resolve_effective_billing_mode
    from agentcore.db.repositories import UserRepository

    user = await UserRepository(session).get_by_id(user_id)
    billing_mode = resolve_effective_billing_mode(user)

    if billing_mode == "platform":
        platform = platform_llm_credentials()
        if platform is None:
            return None
        chat_model = settings.platform_model
        return ModelConfig(
            model=_model_for_purpose(purpose, chat_model=chat_model),
            base_url=platform.base_url,
            api_key=platform.api_key,
            source="platform",
            purpose=purpose,
        )

    # BYOK preference: user key first for all purposes (D6), including background.
    creds = await resolve_user_llm_credentials(session, user_id)
    if creds is not None:
        chat_model = creds.default_model or PLATFORM_MODEL_FLASH
        return ModelConfig(
            model=_model_for_purpose(
                purpose,
                chat_model=chat_model,
                user_background_model=creds.background_model,
            ),
            base_url=creds.base_url,
            api_key=creds.api_key,
            source="byok",
            purpose=purpose,
            price_cache_hit=creds.price_cache_hit,
            price_cache_miss=creds.price_cache_miss,
            price_output=creds.price_output,
            background_model=creds.background_model,
        )
    platform = platform_llm_credentials()
    if platform is not None:
        chat_model = settings.platform_model
        return ModelConfig(
            model=_model_for_purpose(purpose, chat_model=chat_model),
            base_url=platform.base_url,
            api_key=platform.api_key,
            source="platform",
            purpose=purpose,
        )
    return None


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
    user_creds = await resolve_user_llm_credentials(session, user_id)
    return LLMCredentials(
        api_key=cfg.api_key,
        base_url=cfg.base_url,
        default_model=cfg.model,
        source="platform" if cfg.source == "platform" else "user",
        price_cache_hit=user_creds.price_cache_hit if user_creds else None,
        price_cache_miss=user_creds.price_cache_miss if user_creds else None,
        price_output=user_creds.price_output if user_creds else None,
        background_model=user_creds.background_model if user_creds else None,
    )


def resolve_turn_model(credentials: LLMCredentials | None) -> str:
    if credentials is not None:
        return credentials.default_model
    return settings.platform_model


async def resolve_user_chat_model(session: AsyncSession, user_id: str) -> str:
    """Chat model for a user-facing turn — matches inference proxy upstream resolution."""
    cfg = await resolve_model_config(session, user_id, "chat")
    if cfg is not None:
        return cfg.model
    platform = platform_llm_credentials()
    if platform is not None:
        return settings.platform_model
    return PLATFORM_MODEL_FLASH

