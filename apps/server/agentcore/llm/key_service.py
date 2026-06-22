"""BYOK key management service (the write + admin surface).

``llm/byok.py`` is the fail-safe READ path (resolve a turn's credentials, never
raises). This module is its WRITE counterpart for 设置·模型配置: store (encrypt),
display (mask to last-4), clear, and connectivity-test a user's DeepSeek key.
Unlike the resolver it RAISES on misconfiguration (no master key → the key can't
be stored) and surfaces probe failures, so the settings UI gets actionable errors.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.errors import (
    BYOKKeyMissingError,
    KeyStorageUnavailableError,
    LLMError,
    ValidationError,
)
from agentcore.core.logging import get_logger
from agentcore.db.repositories import UserLlmKeyRepository
from agentcore.llm.byok import resolve_user_llm_credentials
from agentcore.llm.config import DEEPSEEK_V4_FLASH
from agentcore.llm.factory import build_provider
from agentcore.security import KeyEncryptor

logger = get_logger(__name__)


@dataclass(frozen=True)
class LlmKeyStatus:
    """The settings view of a user's BYOK key — never the plaintext.

    ``status`` is one of unconfigured / unchecked / active / error (the table's
    status machine plus 'unconfigured' for "no row"). ``masked_key`` shows only
    the last 4 chars for recognition; ``message`` carries a probe failure reason
    for the test endpoint.
    """

    configured: bool
    status: str
    masked_key: str | None = None
    message: str | None = None


def _mask_key(api_key: str) -> str:
    """Display form: last 4 chars only (e.g. ``••••cdef``); never the full key."""
    if len(api_key) <= 4:
        return "••••"
    return f"••••{api_key[-4:]}"


class LlmKeyService:
    """Store / display / clear / connectivity-test a user's BYOK DeepSeek key."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._repo = UserLlmKeyRepository(session)

    def _encryptor(self) -> KeyEncryptor | None:
        """The configured AES encryptor, or ``None`` when the master key is missing
        or malformed — fail-safe, a server that can't encrypt won't store a key."""
        if not settings.encryption_key:
            return None
        try:
            return KeyEncryptor(settings.encryption_key)
        except ValueError:
            logger.error("byok.key_malformed")
            return None

    async def get_status(self, user_id: str) -> LlmKeyStatus:
        """Current key state for 设置·模型配置 (no plaintext; last-4 only)."""
        row = await self._repo.get_by_user_id(user_id)
        if row is None or not row.api_key_enc:
            return LlmKeyStatus(configured=False, status="unconfigured")
        masked: str | None = None
        enc = self._encryptor()
        if enc is not None:
            try:
                masked = _mask_key(enc.decrypt(row.api_key_enc).decode())
            except Exception:  # corrupt ciphertext / rotated key — still "configured"
                masked = None
        return LlmKeyStatus(configured=True, status=row.status, masked_key=masked)

    async def set_key(self, user_id: str, api_key: str) -> LlmKeyStatus:
        """Encrypt + store the user's key, resetting status to 'unchecked'.

        Refuses (503) when no usable master key is configured — the plaintext key
        never lands on disk unencrypted (fail-safe).
        """
        api_key = api_key.strip()
        if not api_key:
            raise ValidationError("API Key 不能为空")
        enc = self._encryptor()
        if enc is None:
            raise KeyStorageUnavailableError(
                "服务端未配置加密主密钥，暂时无法保存 API Key，请联系管理员"
            )
        ciphertext = enc.encrypt(api_key.encode())
        row = await self._repo.upsert(user_id=user_id, api_key_enc=ciphertext)
        return LlmKeyStatus(configured=True, status=row.status, masked_key=_mask_key(api_key))

    async def clear_key(self, user_id: str) -> None:
        """Delete the user's key (idempotent — no error if there was none)."""
        await self._repo.delete(user_id)

    async def test_key(self, user_id: str) -> LlmKeyStatus:
        """Probe DeepSeek with the stored key and persist the outcome.

        Resolves credentials through the SAME path the runtime uses
        (byok.resolve_user_llm_credentials → build_provider), so "测试通过 == 真能
        跑". Maps the probe to 'active' / 'error' and records it.
        """
        row = await self._repo.get_by_user_id(user_id)
        if row is None or not row.api_key_enc:
            raise BYOKKeyMissingError("尚未配置 API Key，无法测试连接")
        credentials = await resolve_user_llm_credentials(self._session, user_id)
        if credentials is None:
            # Row exists but unreadable: master key missing/rotated or corrupt.
            await self._repo.update_status(user_id, "error")
            return LlmKeyStatus(
                configured=True,
                status="error",
                message="无法解密已保存的 Key（服务端密钥变更或数据损坏），请重新填写",
            )
        provider = build_provider(credentials)
        try:
            await provider.probe(model=DEEPSEEK_V4_FLASH)
            status, message = "active", None
        except LLMError as e:
            status, message = "error", str(e)
        finally:
            await provider.close()
        await self._repo.update_status(user_id, status)
        return LlmKeyStatus(
            configured=True,
            status=status,
            masked_key=_mask_key(credentials.api_key),
            message=message,
        )
