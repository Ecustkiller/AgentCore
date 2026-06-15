"""BYOK DeepSeek API key management (设置·模型配置).

The user's single self-supplied DeepSeek key (config.billing_mode "byok"): view
status (last-4 + last connectivity result), store / replace, clear, and
connectivity-test it. Only AES-256-GCM ciphertext is stored, never the plaintext
key (see llm/key_service.py). All routes are scoped to the authenticated user
("me"), so there is no cross-user access to guard.
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.api.dependencies import AuthUser, get_db
from agentcore.api.schemas import (
    LlmKeyStatusResponse,
    SetLlmKeyRequest,
    StatusResponse,
)
from agentcore.llm.key_service import LlmKeyService, LlmKeyStatus

router = APIRouter(prefix="/users/me/llm-key", tags=["llm-key"])


def get_llm_key_service(session: AsyncSession = Depends(get_db)) -> LlmKeyService:
    return LlmKeyService(session)


def _to_response(status: LlmKeyStatus) -> LlmKeyStatusResponse:
    return LlmKeyStatusResponse(
        configured=status.configured,
        status=status.status,
        masked_key=status.masked_key,
        message=status.message,
    )


@router.get("", response_model=LlmKeyStatusResponse)
async def get_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Current BYOK key status (configured? last-4? last connectivity result?)."""
    return _to_response(await service.get_status(user.user_id))


@router.put("", response_model=LlmKeyStatusResponse)
async def set_llm_key(
    body: SetLlmKeyRequest,
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Store or replace the user's DeepSeek key (encrypted at rest; status reset)."""
    return _to_response(await service.set_key(user.user_id, body.api_key))


@router.delete("", response_model=StatusResponse)
async def delete_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Remove the user's stored key (BYOK turns then refuse until one is set again)."""
    await service.clear_key(user.user_id)
    return StatusResponse()


@router.post("/test", response_model=LlmKeyStatusResponse)
async def test_llm_key(
    user: AuthUser,
    service: LlmKeyService = Depends(get_llm_key_service),
):
    """Probe DeepSeek with the stored key and persist 'active' / 'error'."""
    return _to_response(await service.test_key(user.user_id))
