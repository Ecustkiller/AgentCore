"""BYOK LLM configuration management (设置·模型配置).

The user's OpenAI-compatible endpoint config (config.billing_mode "byok"): view
status (last-4 + endpoint/model + last connectivity result), store / replace,
clear, and connectivity-test it. Only AES-256-GCM ciphertext is stored for the
API key (see llm/key_service.py). All routes are scoped to the authenticated user
("me"), so there is no cross-user access to guard.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.api.schemas import (
    LlmKeyStatusResponse,
    SetBillingPreferenceRequest,
    SetLlmKeyRequest,
    StatusResponse,
)
from agentcore.core.logging import get_logger
from agentcore.llm.key_service import LlmKeyService, LlmKeyStatus

logger = get_logger(__name__)

router = APIRouter(prefix="/users/me/llm-key", tags=["llm-key"])


def get_llm_key_service(session: AsyncSession = Depends(get_db)) -> LlmKeyService:
    return LlmKeyService(session)


def _to_response(status: LlmKeyStatus) -> LlmKeyStatusResponse:
    return LlmKeyStatusResponse(
        configured=status.configured,
        status=status.status,
        masked_key=status.masked_key,
        message=status.message,
        base_url=status.base_url,
        default_model=status.default_model,
        byok_model=status.byok_model,
        supports_tools=status.supports_tools,
        billing_mode=status.billing_mode,
        billing_preference=status.billing_preference,
        platform_available=status.platform_available,
        platform_model=status.platform_model,
        free_tier_active=status.free_tier_active,
        price_cache_hit=status.price_cache_hit,
        price_cache_miss=status.price_cache_miss,
        price_output=status.price_output,
        background_model=status.background_model,
    )


@router.put("/billing-preference", response_model=LlmKeyStatusResponse)
async def set_billing_preference(
    body: SetBillingPreferenceRequest,
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Switch between platform free quota and BYOK for the authenticated user."""
    return _to_response(
        await service.set_billing_preference(user.user_id, body.billing_preference)
    )


@router.get("", response_model=LlmKeyStatusResponse)
async def get_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Current BYOK LLM config status (configured? endpoint? last probe result?)."""
    return _to_response(await service.get_status(user.user_id))


@router.put("", response_model=LlmKeyStatusResponse)
async def set_llm_key(
    body: SetLlmKeyRequest,
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Store or replace the user's LLM config (key encrypted at rest; status reset)."""
    status = await service.set_key(
        user.user_id,
        body.api_key,
        base_url=body.base_url,
        default_model=body.default_model,
        price_cache_hit=body.price_cache_hit,
        price_cache_miss=body.price_cache_miss,
        price_output=body.price_output,
        background_model=body.background_model,
    )
    # Activation funnel: LLM key configured (no key material logged).
    logger.info(
        "llm_key.configured",
        user_id=user.user_id,
        base_url=status.base_url,
        default_model=status.default_model,
    )
    return _to_response(status)


@router.delete("", response_model=StatusResponse)
async def delete_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Remove the user's stored config (BYOK turns then refuse until one is set again)."""
    await service.clear_key(user.user_id)
    return StatusResponse()


@router.post("/test", response_model=LlmKeyStatusResponse)
async def test_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Probe the configured endpoint and persist 'active' / 'error' + supports_tools."""
    return _to_response(await service.test_key(user.user_id))
