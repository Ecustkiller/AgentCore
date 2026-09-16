"""Build the optional VisionReader (「插上即用」).

Resolution order:

1. Profile ``vision`` slot (when set) → credentials from that slot (BYOK provider or
   platform model creds), regardless of ``billing_mode``.
2. Else empty slot + main that ``model_accepts_images`` → same build with main's
   :class:`~agentcore.llm.resolve.ModelSelection` (``read_image`` / attachment
   eye→text reuse main credentials). Text-only main does **not** follow.
3. Else platform fallback: ``billing_mode=platform`` + non-empty ``VISION_API_KEY`` /
   ``VISION_BASE_URL`` → operator vision model.
4. Else ``None`` (``read_image`` clean-fails「读图能力未配置」).

Ticketed sidecar never opens local Postgres for this expand. It sends the turn's
inference JWT to ``POST /v1/inference/v1/chat/completions`` with
``X-AgentCore-Role: vision``; the cloud proxy applies the same order.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.config import settings as _default_settings
from agentcore.core.logging import get_logger
from agentcore.vision.protocol import VisionReader
from agentcore.vision.qwen import QwenVLReader

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from agentcore.config.settings import Settings
    from agentcore.llm.credentials import LLMCredentials
    from agentcore.llm.resolve import ModelSelection

logger = get_logger(__name__)


def _model_accepts_images(model_id: str) -> bool:
    """Import seam for ``model_accepts_images`` (vendor table lives in image_accept)."""
    from agentcore.llm.image_accept import model_accepts_images

    return model_accepts_images(model_id)


def build_vision_reader(
    settings: Settings | None = None,
    *,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
    credential_source: str | None = None,
) -> VisionReader | None:
    """Return a :class:`VisionReader` from explicit creds or platform ``VISION_*``.

    Explicit ``api_key`` + non-empty ``base_url`` build a reader **regardless of**
    ``billing_mode`` (profile vision-slot path). Without explicit creds, only
    ``billing_mode=platform`` + complete ``VISION_*`` enable the platform fallback.

    ``credential_source`` stamps pricing origin on the reader (BYOK slot → ``user``,
    platform slot / ``VISION_*`` fallback → ``platform``).
    """
    s = settings if settings is not None else _default_settings
    timeout = float(getattr(s, "vision_timeout_seconds", 60.0) or 60.0)

    if api_key is not None:
        key = (api_key or "").strip()
        url = (base_url or "").strip()
        if not key or not url:
            return None
        mid = (model or "").strip() or (getattr(s, "vision_model", None) or "kimi-k2.5")
        src = credential_source or "platform"
        logger.info("vision.reader_built", model=mid, source="slot", credential_source=src)
        return QwenVLReader(
            api_key=key,
            base_url=url,
            model=mid,
            timeout_seconds=timeout,
            credential_source=src,
        )

    if getattr(s, "billing_mode", "byok") != "platform":
        return None
    if not s.vision_api_key or not (s.vision_base_url or "").strip():
        return None
    logger.info(
        "vision.reader_built",
        model=s.vision_model,
        source="platform",
        credential_source="platform",
    )
    return QwenVLReader(
        api_key=s.vision_api_key,
        base_url=s.vision_base_url,
        model=s.vision_model,
        timeout_seconds=timeout,
        credential_source="platform",
    )


def pick_vision_selection(
    *,
    vision: ModelSelection | None,
    main: ModelSelection | None,
) -> ModelSelection | None:
    """Slot to build a reader from: dedicated vision, else image-accepting main.

    ``None`` means the caller should try platform ``VISION_*`` or leave the
    reader unset (honest「读图能力未配置」).
    """
    if vision is not None:
        return vision
    if main is not None and _model_accepts_images(main.model):
        return main
    return None


def build_proxy_vision_reader(
    credentials: LLMCredentials | None,
    settings: Settings | None = None,
) -> VisionReader | None:
    """Sidecar reader: same inference JWT / base URL as chat; cloud expands the slot.

    Does not open local Postgres. ``proxy_role=vision`` makes the proxy pick the
    vision slot (or image-accepting main / ``VISION_*``), not captain/main.
    """
    from agentcore.costing import ROLE_VISION

    if credentials is None:
        return None
    key = (credentials.api_key or "").strip()
    url = (credentials.base_url or "").strip()
    if not key or not url:
        return None
    s = settings if settings is not None else _default_settings
    timeout = float(getattr(s, "vision_timeout_seconds", 60.0) or 60.0)
    extra = dict(credentials.extra_headers or {})
    logger.info(
        "vision.reader_built",
        model=credentials.default_model,
        source="inference_proxy",
        credential_source=credentials.source,
    )
    return QwenVLReader(
        api_key=key,
        base_url=url,
        model=credentials.default_model,
        timeout_seconds=timeout,
        extra_headers=extra or None,
        proxy_role=ROLE_VISION,
        credential_source=credentials.source,
    )


async def _reader_from_selection(
    session: AsyncSession,
    user_id: str,
    selection: ModelSelection,
    settings: Settings | None,
) -> VisionReader | None:
    """Build a reader from one expanded slot (vision, or main when it accepts images)."""
    from agentcore.llm.resolve import (
        platform_llm_credentials,
        resolve_provider_credentials,
    )

    if selection.origin == "platform":
        creds = platform_llm_credentials(model=selection.model)
        if creds is None:
            return None
        return build_vision_reader(
            settings,
            api_key=creds.api_key,
            base_url=creds.base_url,
            model=selection.model,
            credential_source="platform",
        )
    if not selection.provider_id:
        return None
    creds = await resolve_provider_credentials(session, user_id, selection.provider_id)
    if creds is None:
        return None
    # BYOK slot / followed main → user pricing (estimated ledger), never hardcode platform.
    return build_vision_reader(
        settings,
        api_key=creds.api_key,
        base_url=creds.base_url,
        model=selection.model,
        credential_source="user",
    )


async def resolve_vision_reader(
    session: AsyncSession,
    user_id: str,
    vision: ModelSelection | None,
    settings: Settings | None = None,
    *,
    main: ModelSelection | None = None,
) -> VisionReader | None:
    """Build from vision slot, else image-accepting main, else platform ``VISION_*``."""
    selection = pick_vision_selection(vision=vision, main=main)
    if selection is not None:
        return await _reader_from_selection(session, user_id, selection, settings)
    return build_vision_reader(settings)


async def resolve_vision_reader_for_conversation(
    *,
    user_id: str,
    conversation_id: str,
    settings: Settings | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> VisionReader | None:
    """Resolve the turn's vision reader on the venue that owns credentials.

    Ticketed sidecar must not open local Postgres (岔路 B): point at the cloud
    inference proxy with the turn's JWT. The proxy expands the profile.
    Cloud API process still expands here via a session.
    """
    from agentcore.db.sidecar_tickets import sidecar_narrow_tickets_bound

    if sidecar_narrow_tickets_bound():
        return build_proxy_vision_reader(llm_credentials, settings)

    from agentcore.db.base import async_session_factory
    from agentcore.db.repositories import ConversationRepository
    from agentcore.llm.model_profiles import LlmModelProfileService

    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(
                conversation_id, user_id=user_id
            )
            svc = LlmModelProfileService(session)
            if conv is None:
                expanded = await svc.expand(user_id, None)
            else:
                expanded = await svc.expand_for_conversation(user_id, conv)
            return await resolve_vision_reader(
                session,
                user_id,
                expanded.vision,
                settings=settings,
                main=expanded.main,
            )
    except Exception as e:  # noqa: BLE001 - vision optional; lookup must not break a turn
        logger.warning(
            "vision.resolve_for_conversation_failed",
            user_id=user_id,
            conversation_id=conversation_id,
            error=str(e),
        )
        return build_vision_reader(settings)
