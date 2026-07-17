"""Unit tests for LlmKeyService (BYOK write path)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.config import settings
from agentcore.core.errors import LLMError, ValidationError
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.key_service import LlmKeyService
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH


def _row(**kwargs):
    defaults = {
        "status": "unchecked",
        "base_url": settings.platform_base_url,
        "default_model": DEEPSEEK_V4_FLASH,
        "supports_tools": None,
    }
    defaults.update(kwargs)
    return MagicMock(**defaults)


@pytest.fixture
def service():
    session = MagicMock()
    svc = LlmKeyService(session)
    svc._repo = MagicMock()
    svc._users = MagicMock()
    svc._users.get_by_id = AsyncMock(return_value=MagicMock(billing_preference="byok"))
    svc._repo.get_by_user_id = AsyncMock(return_value=None)
    svc._repo.upsert = AsyncMock(return_value=_row())
    svc._repo.update_status = AsyncMock()
    svc._repo.update_supports_tools = AsyncMock()
    return svc


@pytest.mark.asyncio
async def test_set_key_applies_defaults(service):
    # set_key 落库后经 get_status 复读——repo 需返回已写入的行。
    service._repo.get_by_user_id = AsyncMock(return_value=_row(api_key_enc=b"cipher"))
    with patch.object(service, "_encryptor") as enc_mock:
        enc_mock.return_value.encrypt.return_value = b"cipher"
        status = await service.set_key("u1", "sk-test-key-1234")

    service._repo.upsert.assert_awaited_once_with(
        user_id="u1",
        api_key_enc=b"cipher",
        base_url=settings.platform_base_url,
        default_model=DEEPSEEK_V4_FLASH,
        # 未填单价卡 / 后台模型时显式置空（清除旧值），而非省略参数。
        price_cache_hit=None,
        price_cache_miss=None,
        price_output=None,
        background_model=None,
    )
    assert status.configured is True
    assert status.base_url == settings.platform_base_url
    assert status.default_model == DEEPSEEK_V4_FLASH


@pytest.mark.asyncio
async def test_set_key_rejects_empty_key(service):
    with pytest.raises(ValidationError):
        await service.set_key("u1", "   ")


@pytest.mark.asyncio
async def test_set_key_keeps_ciphertext_when_api_key_omitted(service):
    """已配置用户省略 api_key 时保留原 ciphertext，只更新其它字段。"""
    service._repo.get_by_user_id = AsyncMock(
        return_value=_row(api_key_enc=b"existing-cipher")
    )
    with patch.object(service, "_encryptor") as enc_mock:
        enc_mock.return_value.decrypt.return_value.decode.return_value = "sk-keep"
        status = await service.set_key(
            "u1",
            None,
            base_url="https://api.deepseek.com",
            default_model="deepseek-v4-pro",
        )

    enc_mock.return_value.encrypt.assert_not_called()
    service._repo.upsert.assert_awaited_once_with(
        user_id="u1",
        api_key_enc=b"existing-cipher",
        base_url="https://api.deepseek.com",
        default_model="deepseek-v4-pro",
        price_cache_hit=None,
        price_cache_miss=None,
        price_output=None,
        background_model=None,
    )
    assert status.configured is True


@pytest.mark.asyncio
async def test_get_status_platform_mode_ignores_stored_byok_model(service, monkeypatch):
    """Platform billing runs on PLATFORM_LLM_MODEL, not a dormant BYOK row."""
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(settings, "platform_model", "gpt-5")
    service._users.get_by_id = AsyncMock(
        return_value=MagicMock(billing_preference="platform")
    )
    service._repo.get_by_user_id = AsyncMock(
        return_value=_row(api_key_enc=b"x", default_model=DEEPSEEK_V4_FLASH)
    )

    status = await service.get_status("u1")

    assert status.configured is True
    assert status.default_model == "gpt-5"
    assert status.billing_mode == "platform"
    # default_model 是「生效模型」(平台激活→gpt-5)；byok_model 与之分离，始终如实
    # 回显用户保存的自带模型，供设置页卡片展示，避免平台侧误显示成 gpt-5。
    assert status.byok_model == DEEPSEEK_V4_FLASH


@pytest.mark.asyncio
async def test_get_status_byok_mode_uses_stored_model(service, monkeypatch):
    monkeypatch.setattr(settings, "billing_mode", "byok")
    service._users.get_by_id = AsyncMock(
        return_value=MagicMock(billing_preference="byok")
    )
    service._repo.get_by_user_id = AsyncMock(
        return_value=_row(api_key_enc=b"x", default_model="glm-4")
    )

    with patch.object(service, "_encryptor") as enc_mock:
        enc_mock.return_value.decrypt.return_value.decode.return_value = "sk-test"
        status = await service.get_status("u1")

    assert status.default_model == "glm-4"
    assert status.byok_model == "glm-4"


class _FakeProbeProvider:
    def __init__(self, *, fail: bool, supports_tools: bool | None) -> None:
        self._fail = fail
        self._supports_tools = supports_tools
        self.probe_model: str | None = None

    async def probe(self, *, model: str) -> None:
        self.probe_model = model
        if self._fail:
            raise LLMError("bad key")

    async def probe_tools(self, *, model: str) -> bool | None:
        return self._supports_tools

    async def close(self) -> None:
        pass


@pytest.mark.asyncio
async def test_test_key_uses_user_model_and_records_tools(service):
    service._repo.get_by_user_id = AsyncMock(return_value=_row(api_key_enc=b"x"))
    creds = LLMCredentials(
        api_key="sk-abc",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o",
    )
    fake = _FakeProbeProvider(fail=False, supports_tools=True)

    with (
        patch(
            "agentcore.llm.key_service.resolve_user_llm_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.key_service.build_provider", return_value=fake),
    ):
        status = await service.test_key("u1")

    assert fake.probe_model == "gpt-4o"
    assert status.status == "active"
    assert status.supports_tools is True
    service._repo.update_supports_tools.assert_awaited_once_with("u1", True)


@pytest.mark.asyncio
async def test_test_key_persists_unknown_tools_as_none(service):
    service._repo.get_by_user_id = AsyncMock(return_value=_row(api_key_enc=b"x"))
    creds = LLMCredentials(
        api_key="sk-abc",
        base_url="https://api.openai.com/v1",
        default_model="gpt-4o",
    )
    fake = _FakeProbeProvider(fail=False, supports_tools=None)

    with (
        patch(
            "agentcore.llm.key_service.resolve_user_llm_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.key_service.build_provider", return_value=fake),
    ):
        status = await service.test_key("u1")

    assert status.status == "active"
    assert status.supports_tools is None
    service._repo.update_supports_tools.assert_awaited_once_with("u1", None)
