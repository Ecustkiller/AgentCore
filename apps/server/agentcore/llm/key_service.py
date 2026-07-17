"""BYOK LLM configuration service (the write + admin surface).

``llm/byok.py`` is the fail-safe READ path (resolve a turn's credentials, never
raises). This module is its WRITE counterpart for 设置·模型配置: store (encrypt),
display (mask to last-4), clear, and connectivity-test a user's OpenAI-compatible
endpoint config. Unlike the resolver it RAISES on misconfiguration (no master key
→ the key can't be stored) and surfaces probe failures, so the settings UI gets
actionable errors.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.billing.preference import (
    is_free_tier_active,
    is_platform_available,
    resolve_effective_billing_mode,
    validate_billing_preference,
)
from agentcore.config import settings
from agentcore.core.errors import (
    BYOKKeyMissingError,
    KeyStorageUnavailableError,
    LLMError,
    PlatformBillingUnavailableError,
    ValidationError,
)
from agentcore.core.logging import get_logger
from agentcore.db.repositories import UserLlmKeyRepository, UserRepository
from agentcore.llm.factory import build_provider
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.resolve import resolve_user_llm_credentials
from agentcore.security.keys import KeyEncryptor

logger = get_logger(__name__)


@dataclass(frozen=True)
class LlmKeyStatus:
    configured: bool
    status: str
    masked_key: str | None = None
    message: str | None = None
    base_url: str | None = None
    default_model: str | None = None
    byok_model: str | None = None
    supports_tools: bool | None = None
    billing_mode: str = "byok"
    billing_preference: str = "byok"
    platform_available: bool = False
    platform_model: str | None = None
    free_tier_active: bool = False
    price_cache_hit: str | None = None
    price_cache_miss: str | None = None
    price_output: str | None = None
    background_model: str | None = None


def _mask_key(api_key: str) -> str:
    """Display form: last 4 chars only (e.g. ``••••cdef``); never the full key."""
    if len(api_key) <= 4:
        return "••••"
    return f"••••{api_key[-4:]}"


def _status_from_row(row) -> LlmKeyStatus:
    return LlmKeyStatus(
        configured=True,
        status=row.status,
        base_url=row.base_url,
        default_model=row.default_model,
        supports_tools=row.supports_tools,
        price_cache_hit=getattr(row, "price_cache_hit", None),
        price_cache_miss=getattr(row, "price_cache_miss", None),
        price_output=getattr(row, "price_output", None),
        background_model=getattr(row, "background_model", None),
    )


class LlmKeyService:
    """Store / display / clear / connectivity-test a user's BYOK LLM config."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._repo = UserLlmKeyRepository(session)
        self._users = UserRepository(session)

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

    def _billing_context(self, user) -> tuple[str, str, bool, str | None]:
        """(effective mode, stored preference, platform_available, platform_model)."""
        preference = user.billing_preference if user is not None else "byok"
        effective = resolve_effective_billing_mode(user)
        platform_available = is_platform_available()
        platform_model = settings.platform_model if platform_available else None
        return effective, preference, platform_available, platform_model

    def _effective_default_model(
        self, *, billing_mode: str, row_default: str | None
    ) -> str | None:
        """Model id the runtime actually uses for user-facing turns.

        Platform billing ignores per-user BYOK rows and always runs on the operator
        platform model; the settings/badge surface must echo that, not a dormant
        ``user_llm_keys.default_model`` left over from BYOK mode or migration.
        """
        if billing_mode == "platform":
            return settings.platform_model
        return row_default

    async def get_status(self, user_id: str) -> LlmKeyStatus:
        """Current config state for 设置·模型配置 (no plaintext; last-4 only)."""
        user = await self._users.get_by_id(user_id)
        billing_mode, billing_preference, platform_available, platform_model = (
            self._billing_context(user)
        )
        row = await self._repo.get_by_user_id(user_id)
        has_key = row is not None and bool(row.api_key_enc)
        free_tier = is_free_tier_active(has_user_key=has_key)
        if not has_key:
            if billing_mode == "platform":
                return LlmKeyStatus(
                    configured=False,
                    status="platform",
                    default_model=self._effective_default_model(
                        billing_mode=billing_mode, row_default=None
                    ),
                    billing_mode=billing_mode,
                    billing_preference=billing_preference,
                    platform_available=platform_available,
                    platform_model=platform_model,
                    free_tier_active=free_tier,
                )
            return LlmKeyStatus(
                configured=False,
                status="unconfigured",
                billing_mode=billing_mode,
                billing_preference=billing_preference,
                platform_available=platform_available,
                free_tier_active=free_tier,
            )
        masked: str | None = None
        enc = self._encryptor()
        if enc is not None:
            try:
                masked = _mask_key(enc.decrypt(row.api_key_enc).decode())
            except Exception:  # corrupt ciphertext / rotated key — still "configured"
                masked = None
        base = _status_from_row(row)
        return LlmKeyStatus(
            configured=base.configured,
            status=base.status,
            masked_key=masked,
            base_url=base.base_url,
            default_model=self._effective_default_model(
                billing_mode=billing_mode, row_default=base.default_model
            ),
            byok_model=base.default_model,
            supports_tools=base.supports_tools,
            billing_mode=billing_mode,
            billing_preference=billing_preference,
            platform_available=platform_available,
            platform_model=platform_model,
            free_tier_active=False,
            price_cache_hit=base.price_cache_hit,
            price_cache_miss=base.price_cache_miss,
            price_output=base.price_output,
            background_model=base.background_model,
        )

    async def set_billing_preference(self, user_id: str, preference: str) -> LlmKeyStatus:
        """Switch the user's billing mode (platform free quota vs BYOK)."""
        try:
            mode = validate_billing_preference(preference)
        except ValueError as e:
            raise ValidationError(str(e)) from e
        if mode == "platform" and not is_platform_available():
            raise PlatformBillingUnavailableError(
                "平台免费额度暂不可用（运营方未配置平台 Key），无法切换。"
            )
        updated = await self._users.set_billing_preference(user_id, mode)
        if updated is None:
            raise ValidationError("用户不存在")
        return await self.get_status(user_id)

    async def set_key(
        self,
        user_id: str,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        default_model: str | None = None,
        price_cache_hit: str | None = None,
        price_cache_miss: str | None = None,
        price_output: str | None = None,
        background_model: str | None = None,
    ) -> LlmKeyStatus:
        """Encrypt + store the user's LLM config, resetting status to 'unchecked'.

        ``base_url`` / ``default_model`` default to platform / BYOK legacy values so
        old clients that only send ``api_key`` keep working.

        When ``api_key`` is omitted/empty and the user already has a stored key,
        the existing ciphertext is kept and only endpoint/model/price fields update.
        First-time setup still requires a non-empty key.

        Refuses (503) when encrypting a new key and no usable master key is
        configured — the plaintext key never lands on disk unencrypted (fail-safe).
        """
        api_key = (api_key or "").strip()
        existing = await self._repo.get_by_user_id(user_id)
        if not api_key:
            if existing is None or not existing.api_key_enc:
                raise ValidationError("API Key 不能为空")
            ciphertext = existing.api_key_enc
        else:
            enc = self._encryptor()
            if enc is None:
                raise KeyStorageUnavailableError(
                    "服务端未配置加密主密钥，暂时无法保存 API Key，请联系管理员"
                )
            ciphertext = enc.encrypt(api_key.encode())
        resolved_base_url = (base_url or settings.platform_base_url).strip()
        if not resolved_base_url:
            raise ValidationError("Base URL 不能为空")
        resolved_model = (default_model or DEEPSEEK_V4_FLASH).strip()
        if not resolved_model:
            raise ValidationError("模型名称不能为空")
        from agentcore.llm.pricing import parse_user_prices

        # Unit card: input (cache_miss) + output are the required pair; cache_hit
        # is optional (pricing defaults it to the input price — no cache
        # discount). Leaving every field empty clears the card.
        price_fields = (price_cache_hit, price_cache_miss, price_output)
        has_core = all(p and str(p).strip() for p in (price_cache_miss, price_output))
        if any(price_fields) and not has_core:
            raise ValidationError("单价须至少填写输入与输出两项（缓存命中价可选），或全部留空")
        if has_core and parse_user_prices(
            cache_hit=price_cache_hit, cache_miss=price_cache_miss, output=price_output
        ) is None:
            raise ValidationError("单价须为非负十进制数字（USD per 1M tokens）")
        await self._repo.upsert(
            user_id=user_id,
            api_key_enc=ciphertext,
            base_url=resolved_base_url,
            default_model=resolved_model,
            price_cache_hit=(price_cache_hit.strip() if price_cache_hit else None),
            price_cache_miss=(price_cache_miss.strip() if price_cache_miss else None),
            price_output=(price_output.strip() if price_output else None),
            background_model=(background_model.strip() if background_model else None),
        )
        return await self.get_status(user_id)

    async def clear_key(self, user_id: str) -> None:
        """Delete the user's config (idempotent — no error if there was none)."""
        await self._repo.delete(user_id)

    async def test_key(self, user_id: str) -> LlmKeyStatus:
        """Probe the configured endpoint and persist connectivity + tool support.

        Resolves credentials through the SAME path the runtime uses
        (byok.resolve_user_llm_credentials → build_provider), so "测试通过 == 真能
        跑". Maps the probe to 'active' / 'error', records ``supports_tools``.
        """
        row = await self._repo.get_by_user_id(user_id)
        if row is None or not row.api_key_enc:
            raise BYOKKeyMissingError("尚未配置 API Key，无法测试连接")
        credentials = await resolve_user_llm_credentials(self._session, user_id)
        if credentials is None:
            await self._repo.update_status(user_id, "error")
            return LlmKeyStatus(
                configured=True,
                status="error",
                message="无法解密已保存的 Key（服务端密钥变更或数据损坏），请重新填写",
                base_url=row.base_url,
                default_model=row.default_model,
            )
        provider = build_provider(credentials)
        model = credentials.default_model
        supports_tools: bool | None = None
        try:
            await provider.probe(model=model)
            status, message = "active", None
            supports_tools = await provider.probe_tools(model=model)
        except LLMError as e:
            status, message = "error", str(e)
        finally:
            await provider.close()
        await self._repo.update_status(user_id, status)
        if status == "active":
            await self._repo.update_supports_tools(user_id, supports_tools)
        return LlmKeyStatus(
            configured=True,
            status=status,
            masked_key=_mask_key(credentials.api_key),
            message=message,
            base_url=credentials.base_url,
            default_model=credentials.default_model,
            supports_tools=supports_tools if status == "active" else row.supports_tools,
        )
