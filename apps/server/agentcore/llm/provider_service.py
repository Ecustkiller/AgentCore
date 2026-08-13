"""BYOK LLM provider configuration service (the write + admin surface).

The read path (resolve a turn's credentials, never raises) lives in ``llm/resolve.py``.
This module is its WRITE counterpart for 设置·模型配置 over a LIST of providers: add /
edit / remove / connectivity-test each OpenAI-compatible endpoint. Account model
selection uses ``llm/model_profiles.py`` (模型组合) — not per-slot pointers here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.billing.allowance import invalidate_allowance
from agentcore.billing.preference import (
    platform_catalog_visible,
)
from agentcore.config import settings
from agentcore.core.errors import (
    BYOKKeyMissingError,
    KeyStorageUnavailableError,
    NotFoundError,
    ValidationError,
)
from agentcore.core.logging import get_logger
from agentcore.db.models import UserLlmProvider
from agentcore.db.repositories import (
    LlmModelProfileRepository,
    UserLlmProviderRepository,
    UserRepository,
)
from agentcore.llm.factory import build_provider
from agentcore.llm.model_profiles import ProfileSlot
from agentcore.llm.model_reachability import (
    CONNECTIVITY_POLICY,
    check_model_reachable,
    fetch_model_list,
)
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.resolve import resolve_provider_credentials
from agentcore.security.keys import KeyEncryptor

logger = get_logger(__name__)

# Shown when connectivity test succeeds with no other message — clarifies that
# green ≠ chat-ready; daily chat uses 模型组合 main model, not this probe.
CONNECTIVITY_OK_HINT = (
    "连接正常。已验证服务商连通（模型列表或 chat 试探）。"
    "日常聊天请到「模型组合」配置主模型；"
    "自定义 Base URL 通常需含 /v1（例如 https://api.example.com/v1）。"
)


@dataclass(frozen=True)
class LlmProviderView:
    """Settings view of one BYOK provider — never the plaintext key."""

    id: str
    label: str
    base_url: str
    default_model: str
    status: str
    masked_key: str | None = None
    supports_tools: bool | None = None
    message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


@dataclass(frozen=True)
class LlmProvidersView:
    """Provider list + deployment caps (+ account default profile id)."""

    providers: list[LlmProviderView] = field(default_factory=list)
    default_model_profile_id: str | None = None
    billing_mode: str = "byok"
    platform_available: bool = False
    platform_model: str | None = None


def _mask_key_ciphertext(enc: KeyEncryptor | None, api_key_enc: bytes) -> str | None:
    if enc is None or not api_key_enc:
        return None
    try:
        plaintext = enc.decrypt(api_key_enc).decode()
    except Exception:  # noqa: BLE001
        return None
    return _mask_key(plaintext)


def _mask_key(api_key: str) -> str:
    if len(api_key) <= 4:
        return "••••"
    return f"••••{api_key[-4:]}"


class LlmProviderService:
    """Add / edit / remove / connectivity-test a user's BYOK providers."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._repo = UserLlmProviderRepository(session)
        self._users = UserRepository(session)
        self._profiles = LlmModelProfileRepository(session)

    def _encryptor(self) -> KeyEncryptor | None:
        if not settings.encryption_key:
            return None
        try:
            return KeyEncryptor(settings.encryption_key)
        except ValueError:
            logger.error("byok.key_malformed")
            return None

    def _view(
        self,
        row: UserLlmProvider,
        *,
        enc: KeyEncryptor | None,
        message: str | None = None,
    ) -> LlmProviderView:
        return LlmProviderView(
            id=row.id,
            label=row.label or "",
            base_url=row.base_url,
            default_model=row.default_model,
            status=row.status,
            masked_key=_mask_key_ciphertext(enc, row.api_key_enc),
            supports_tools=row.supports_tools,
            message=message,
            created_at=row.created_at,
            updated_at=row.updated_at,
        )

    async def list_providers(self, user_id: str) -> LlmProvidersView:
        enc = self._encryptor()
        user = await self._users.get_by_id(user_id)
        rows = await self._repo.list_for_user(user_id)
        providers = [self._view(row, enc=enc) for row in rows]
        platform_available = platform_catalog_visible()
        return LlmProvidersView(
            providers=providers,
            default_model_profile_id=(
                getattr(user, "default_model_profile_id", None) if user else None
            ),
            billing_mode=settings.billing_mode,
            platform_available=platform_available,
            platform_model=settings.platform_model if platform_available else None,
        )

    async def create_provider(
        self,
        user_id: str,
        *,
        label: str,
        api_key: str,
        base_url: str | None = None,
        default_model: str | None = None,
    ) -> LlmProviderView:
        """Add a provider. First provider auto-creates a「当前配置」profile as default."""
        api_key = (api_key or "").strip()
        if not api_key:
            raise ValidationError("API Key 不能为空")
        from agentcore.llm.credentials import require_http_header_safe_api_key

        api_key = require_http_header_safe_api_key(api_key)
        enc = self._encryptor()
        if enc is None:
            raise KeyStorageUnavailableError(
                "服务端未配置加密主密钥，暂时无法保存 API Key，请联系管理员"
            )
        resolved_base_url = (base_url or settings.platform_base_url).strip()
        if not resolved_base_url:
            raise ValidationError("Base URL 不能为空")
        resolved_model = (default_model or DEEPSEEK_V4_FLASH).strip()
        if not resolved_model:
            raise ValidationError("模型名称不能为空")

        was_empty = (await self._repo.count_for_user(user_id)) == 0
        row = await self._repo.create(
            user_id=user_id,
            label=label,
            api_key_enc=enc.encrypt(api_key.encode()),
            base_url=resolved_base_url,
            default_model=resolved_model,
        )
        if was_empty:
            from agentcore.llm.model_profiles import LlmModelProfileService

            await LlmModelProfileService(self._session).create_profile(
                user_id,
                name="当前配置",
                main=ProfileSlot(
                    origin="byok", model=row.default_model, provider_id=row.id
                ),
                set_as_default=True,
            )
        # A different upstream is being asked now: anything cached about the old one
        # refusing this account (背景整理的申报冷却) no longer describes reality — and
        # 「接入自己的 key」is the very exit the 429 copy offers.
        invalidate_allowance(user_id, reason="byok_provider_changed")
        return self._view(row, enc=enc)

    async def update_provider(
        self,
        user_id: str,
        provider_id: str,
        *,
        label: str | None = None,
        api_key: str | None = None,
        base_url: str | None = None,
        default_model: str | None = None,
        fields_set: set[str],
    ) -> LlmProviderView:
        existing = await self._repo.get(provider_id, user_id=user_id)
        if existing is None:
            raise NotFoundError("服务商不存在")

        kwargs: dict[str, object] = {}
        if "label" in fields_set:
            kwargs["label"] = label or ""
        if "api_key" in fields_set and (api_key or "").strip():
            enc = self._encryptor()
            if enc is None:
                raise KeyStorageUnavailableError(
                    "服务端未配置加密主密钥，暂时无法保存 API Key，请联系管理员"
                )
            from agentcore.llm.credentials import require_http_header_safe_api_key

            safe_key = require_http_header_safe_api_key(api_key.strip())
            kwargs["api_key_enc"] = enc.encrypt(safe_key.encode())
        if "base_url" in fields_set:
            resolved = (base_url or settings.platform_base_url).strip()
            if not resolved:
                raise ValidationError("Base URL 不能为空")
            kwargs["base_url"] = resolved
        if "default_model" in fields_set:
            resolved_model = (default_model or "").strip()
            if not resolved_model:
                raise ValidationError("模型名称不能为空")
            kwargs["default_model"] = resolved_model

        row = await self._repo.update(provider_id, user_id=user_id, **kwargs)  # type: ignore[arg-type]
        assert row is not None
        # Only a credential-shaped edit changes what upstream would answer; renaming
        # the 服务商 does not, so it must not retire a cooldown that still holds.
        if kwargs.keys() & {"api_key_enc", "base_url", "default_model"}:
            invalidate_allowance(user_id, reason="byok_provider_changed")
        return self._view(row, enc=self._encryptor())

    async def delete_provider(self, user_id: str, provider_id: str) -> None:
        """Remove a provider; profile slots referencing it are cleared / retargeted."""
        removed = await self._repo.delete(provider_id, user_id=user_id)
        if not removed:
            raise NotFoundError("服务商不存在")

        fallback = await self._repo.first_for_user(user_id)
        if fallback is not None:
            await self._profiles.retarget_main_provider(
                user_id,
                from_provider_id=provider_id,
                to_provider_id=fallback.id,
                to_model=fallback.default_model,
                to_origin="byok",
            )
        else:
            await self._profiles.retarget_main_provider(
                user_id,
                from_provider_id=provider_id,
                to_provider_id=None,
                to_model=DEEPSEEK_V4_FLASH,
                to_origin="platform",
            )
        await self._profiles.clear_provider_refs(user_id, provider_id)
        invalidate_allowance(user_id, reason="byok_provider_changed")

    async def test_provider(self, user_id: str, provider_id: str) -> LlmProviderView:
        row = await self._repo.get(provider_id, user_id=user_id)
        if row is None:
            raise NotFoundError("服务商不存在")
        if not row.api_key_enc:
            raise BYOKKeyMissingError("尚未配置 API Key，无法测试连接")
        credentials = await resolve_provider_credentials(self._session, user_id, provider_id)
        enc = self._encryptor()
        if credentials is None:
            await self._repo.update_status(provider_id, "error")
            fresh = await self._repo.get(provider_id, user_id=user_id)
            assert fresh is not None
            return self._view(
                fresh,
                enc=enc,
                message="无法解密已保存的 Key（服务端密钥变更或数据损坏），请重新填写",
            )
        # User-facing errors use credentials.label (never internal source ``user``).
        provider = build_provider(credentials)
        model = (credentials.default_model or "").strip()
        base_url = credentials.base_url
        supports_tools: bool | None = None
        logger.info(
            "llm_provider.test.start",
            user_id=user_id,
            provider_id=provider_id,
            base_url=base_url,
            model=model,
            provider_type=type(provider).__name__,
        )
        try:
            status, message, supports_tools = await self._run_connectivity_test(
                provider,
                model=model,
                profile_models=await self._profile_models_for_provider(
                    user_id, provider_id
                ),
            )
            if status == "error":
                logger.warning(
                    "llm_provider.test.failed",
                    user_id=user_id,
                    provider_id=provider_id,
                    base_url=base_url,
                    model=model,
                    error=message,
                )
            else:
                logger.info(
                    "llm_provider.test.ok",
                    user_id=user_id,
                    provider_id=provider_id,
                    base_url=base_url,
                    model=model,
                    supports_tools=supports_tools,
                )
        except Exception:
            logger.exception(
                "llm_provider.test.unhandled",
                user_id=user_id,
                provider_id=provider_id,
                base_url=base_url,
                model=model,
                provider_type=type(provider).__name__,
            )
            raise
        finally:
            await provider.close()
        await self._repo.update_status(provider_id, status)
        if status == "active":
            await self._repo.update_supports_tools(provider_id, supports_tools)
            if not message:
                message = CONNECTIVITY_OK_HINT
        fresh = await self._repo.get(provider_id, user_id=user_id)
        assert fresh is not None
        return self._view(fresh, enc=enc, message=message)

    async def _profile_models_for_provider(
        self, user_id: str, provider_id: str
    ) -> list[str]:
        """Distinct model ids from profile slots that point at this BYOK provider."""
        rows = await self._profiles.list_for_user(user_id, include_implicit=True)
        found: list[str] = []
        seen: set[str] = set()
        for row in rows:
            for origin, pid, model in (
                (row.main_origin, row.main_provider_id, row.main_model),
                (row.worker_origin, row.worker_provider_id, row.worker_model),
                (
                    row.background_origin,
                    row.background_provider_id,
                    row.background_model,
                ),
                (row.vision_origin, row.vision_provider_id, row.vision_model),
            ):
                if origin != "byok" or pid != provider_id:
                    continue
                model_s = (model or "").strip()
                if not model_s or model_s in seen:
                    continue
                seen.add(model_s)
                found.append(model_s)
        return found

    async def _run_connectivity_test(
        self,
        provider: object,
        *,
        model: str,
        profile_models: list[str] | None = None,
    ) -> tuple[str, str | None, bool | None]:
        """Prefer ``list_models`` (connection OK); fall back to ``probe(default_model)``.

        Auth / balance failures from ``list_models`` are hard errors. Other
        ``list_models`` failures fall through to the legacy probe path. When
        ``list_models`` succeeds but the default model is absent from a
        non-empty upstream list, also fall through to ``probe`` (e.g. Ark
        ``ep-`` endpoints that chat but are omitted from ``/models``). An
        **empty** upstream list also falls through to ``probe`` — a JSON
        ``data: []`` must not soft-green without a chat body check. After the
        provider ``default_model`` passes, also check models referenced by the
        user's 模型组合 slots for this provider — failure names the bad model.
        Tools probing is best-effort and never flips an otherwise-active result
        to error.
        """
        model_list = await fetch_model_list(provider)
        reach, message = await check_model_reachable(
            provider,
            model=model,
            model_list=model_list,
            policy=CONNECTIVITY_POLICY,
        )
        if reach == "error":
            return "error", message, None

        supports_tools = await self._best_effort_probe_tools(provider, model=model)

        checked = {(model or "").strip()} if (model or "").strip() else set()
        for extra in profile_models or ():
            extra_s = (extra or "").strip()
            if not extra_s or extra_s in checked:
                continue
            checked.add(extra_s)
            extra_reach, extra_msg = await check_model_reachable(
                provider,
                model=extra_s,
                model_list=model_list,
                policy=CONNECTIVITY_POLICY,
            )
            if extra_reach == "error":
                detail = extra_msg or "连接失败"
                return (
                    "error",
                    f"模型组合引用的模型「{extra_s}」不可用：{detail}",
                    None,
                )

        return "active", None, supports_tools

    @staticmethod
    async def _best_effort_probe_tools(provider: object, *, model: str) -> bool | None:
        probe_tools = getattr(provider, "probe_tools", None)
        if not callable(probe_tools) or not model:
            return None
        try:
            return await probe_tools(model=model)
        except Exception:  # noqa: BLE001 — tools probe must not fail the whole test
            logger.warning(
                "llm_provider.test.probe_tools_failed",
                model=model,
                exc_info=True,
            )
            return None
