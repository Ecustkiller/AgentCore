"""Unit tests for LlmProviderService (BYOK 多服务商 write path · 模型组合硬切后)."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from structlog.testing import capture_logs

from agentcore.config import settings
from agentcore.core.errors import (
    KeyStorageUnavailableError,
    LLMError,
    NotFoundError,
    ValidationError,
)
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.profiles import DEEPSEEK_V4_FLASH
from agentcore.llm.provider_service import LlmProviderService

pytestmark = pytest.mark.anyio


def _row(**kwargs):
    defaults = {
        "id": "prov-1",
        "user_id": "u1",
        "label": "DeepSeek",
        "api_key_enc": b"cipher",
        "base_url": settings.platform_base_url,
        "default_model": DEEPSEEK_V4_FLASH,
        "supports_tools": None,
        "status": "unchecked",
        "created_at": datetime.now(UTC),
        "updated_at": datetime.now(UTC),
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def _user(**kwargs):
    defaults = {
        "user_id": "u1",
        "default_model_profile_id": None,
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


@pytest.fixture
def service():
    svc = LlmProviderService(MagicMock())
    svc._repo = MagicMock()
    svc._users = MagicMock()
    svc._profiles = MagicMock()
    svc._repo.count_for_user = AsyncMock(return_value=0)
    svc._repo.create = AsyncMock(return_value=_row())
    svc._repo.get = AsyncMock(return_value=_row())
    svc._repo.list_for_user = AsyncMock(return_value=[_row()])
    svc._repo.update = AsyncMock(return_value=_row())
    svc._repo.update_status = AsyncMock()
    svc._repo.update_supports_tools = AsyncMock()
    svc._repo.first_for_user = AsyncMock(return_value=None)
    svc._repo.delete = AsyncMock(return_value=True)
    svc._users.get_by_id = AsyncMock(return_value=_user())
    svc._profiles.retarget_main_provider = AsyncMock()
    svc._profiles.clear_provider_refs = AsyncMock()
    return svc


def _enc():
    enc = MagicMock()
    enc.encrypt.return_value = b"cipher"
    enc.decrypt.return_value = b"sk-secret-1234"
    return enc


async def test_create_provider_first_seeds_current_config_profile(service):
    created = MagicMock()
    with (
        patch.object(service, "_encryptor", return_value=_enc()),
        patch(
            "agentcore.llm.model_profiles.LlmModelProfileService.create_profile",
            new=AsyncMock(return_value=created),
        ) as create_profile,
    ):
        view = await service.create_provider(
            "u1", label="DeepSeek", api_key="sk-secret-1234"
        )
    create_profile.assert_awaited_once()
    kwargs = create_profile.await_args.kwargs
    assert kwargs["name"] == "当前配置"
    assert kwargs["set_as_default"] is True
    assert kwargs["main"].origin == "byok"
    assert kwargs["main"].provider_id == "prov-1"
    assert view.id == "prov-1"
    assert view.masked_key == "••••1234"


async def test_create_provider_second_does_not_seed_profile(service):
    service._repo.count_for_user = AsyncMock(return_value=1)
    with (
        patch.object(service, "_encryptor", return_value=_enc()),
        patch(
            "agentcore.llm.model_profiles.LlmModelProfileService.create_profile",
            new=AsyncMock(),
        ) as create_profile,
    ):
        await service.create_provider("u1", label="Kimi", api_key="sk-second-key")
    create_profile.assert_not_awaited()


async def test_create_provider_rejects_empty_key(service):
    with pytest.raises(ValidationError):
        await service.create_provider("u1", label="X", api_key="   ")


async def test_create_provider_rejects_fullwidth_in_key(service):
    """Fullwidth punctuation in Key → ValidationError (not UnicodeEncodeError 500)."""
    with (
        patch.object(service, "_encryptor", return_value=_enc()),
        pytest.raises(ValidationError, match="全角|中文符号"),
    ):
        await service.create_provider(
            "u1", label="X", api_key="sk-test（revoked）"
        )


async def test_update_provider_rejects_fullwidth_in_key(service):
    with (
        patch.object(service, "_encryptor", return_value=_enc()),
        pytest.raises(ValidationError, match="全角|中文符号"),
    ):
        await service.update_provider(
            "u1",
            "prov-1",
            api_key="sk-bad（x）",
            fields_set={"api_key"},
        )


async def test_create_provider_without_master_key_raises(service):
    with (
        patch.object(service, "_encryptor", return_value=None),
        pytest.raises(KeyStorageUnavailableError),
    ):
        await service.create_provider("u1", label="X", api_key="sk-x")


async def test_list_providers_reports_profile_id_and_platform(service, monkeypatch):
    from agentcore.llm.model_profiles import platform_preset_id

    preset = platform_preset_id("glm-5.2")
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(settings, "billing_mode", "platform")
    service._repo.list_for_user = AsyncMock(return_value=[])
    service._users.get_by_id = AsyncMock(
        return_value=_user(default_model_profile_id=preset)
    )
    view = await service.list_providers("u1")
    assert view.providers == []
    assert view.default_model_profile_id == preset
    assert view.platform_available is True


async def test_list_providers_platform_signal_false_when_dormant(service, monkeypatch):
    """byok + key still present → platform_available false."""
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(settings, "billing_mode", "byok")
    monkeypatch.setattr(settings, "platform_model", "plat-model")
    service._repo.list_for_user = AsyncMock(return_value=[])
    service._users.get_by_id = AsyncMock(return_value=_user())
    view = await service.list_providers("u1")
    assert view.platform_available is False
    assert view.platform_model is None


class _FakeProbeProvider:
    def __init__(
        self,
        *,
        fail: bool = False,
        supports_tools: bool | None = None,
        model_ids: list[str] | None = None,
        list_models_error: Exception | None = None,
        probe_tools_raises: bool = False,
    ) -> None:
        self._fail = fail
        self._supports_tools = supports_tools
        self._model_ids = model_ids
        self._list_models_error = list_models_error
        self._probe_tools_raises = probe_tools_raises
        self.probe_model: str | None = None
        self.list_models_called = False
        self.probe_called = False

    async def list_models(self) -> list[str]:
        self.list_models_called = True
        if self._list_models_error is not None:
            raise self._list_models_error
        if self._model_ids is None:
            raise LLMError("list_models unavailable")
        return list(self._model_ids)

    async def probe(self, *, model: str) -> None:
        self.probe_called = True
        self.probe_model = model
        if self._fail:
            raise LLMError("bad key")

    async def probe_tools(self, *, model: str) -> bool | None:
        if self._probe_tools_raises:
            raise RuntimeError("tools probe boom")
        return self._supports_tools

    async def close(self) -> None:
        pass


async def test_test_provider_records_active_and_tools(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="active", supports_tools=True),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://api.openai.com/v1", default_model="gpt-4o"
    )
    fake = _FakeProbeProvider(model_ids=["gpt-4o", "gpt-4o-mini"], supports_tools=True)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake) as build,
        patch.object(service, "_encryptor", return_value=_enc()),
        capture_logs() as caps,
    ):
        view = await service.test_provider("u1", "prov-1")
    build.assert_called_once()
    assert build.call_args.kwargs.get("display_name") == "DeepSeek"
    assert fake.list_models_called is True
    assert fake.probe_called is False
    assert view.status == "active"
    assert view.message is not None
    assert "连通" in view.message and "模型组合" in view.message
    service._repo.update_status.assert_awaited_once_with("prov-1", "active")
    service._repo.update_supports_tools.assert_awaited_once_with("prov-1", True)
    start = next(c for c in caps if c.get("event") == "llm_provider.test.start")
    assert start["provider_id"] == "prov-1"
    assert start["model"] == "gpt-4o"
    assert start["base_url"] == "https://api.openai.com/v1"
    ok = next(c for c in caps if c.get("event") == "llm_provider.test.ok")
    assert ok["supports_tools"] is True


async def test_test_provider_empty_models_list_falls_through_to_probe(service):
    """JSON data:[] must not soft-green — chat probe (body-checked) required."""
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="active", supports_tools=None),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://gw.example/v1", default_model="gpt-4o"
    )
    fake = _FakeProbeProvider(model_ids=[], supports_tools=None)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert fake.list_models_called is True
    assert fake.probe_called is True
    assert view.status == "active"


async def test_test_provider_probes_when_default_model_missing_from_list(service):
    """Model absent from non-empty /models list → fall through to probe (not soft-green)."""
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x", label="My Gateway"),
            _row(api_key_enc=b"x", status="active", supports_tools=None),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://gw.example/v1", default_model="stale-model"
    )
    fake = _FakeProbeProvider(model_ids=["gpt-4o"], supports_tools=None)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake) as build,
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert build.call_args.kwargs.get("display_name") == "My Gateway"
    assert fake.list_models_called is True
    assert fake.probe_called is True
    assert fake.probe_model == "stale-model"
    assert view.status == "active"
    assert view.message is not None
    assert "连通" in view.message and "模型组合" in view.message
    service._repo.update_status.assert_awaited_once_with("prov-1", "active")


async def test_test_provider_missing_from_list_probe_failure_is_error(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="error"),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://gw.example/v1", default_model="stale-model"
    )
    fake = _FakeProbeProvider(model_ids=["gpt-4o"], fail=True, supports_tools=None)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert fake.list_models_called is True
    assert fake.probe_called is True
    assert fake.probe_model == "stale-model"
    assert view.status == "error"
    assert view.message == "bad key"
    assert "模型组合" not in view.message


async def test_test_provider_missing_from_list_probe_success_is_active(service):
    """Ark-style ep- id may be absent from /models yet still chat successfully."""
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="active", supports_tools=True),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc",
        base_url="https://ark.cn-beijing.volces.com/api/v3",
        default_model="ep-20240101000000-abcde",
    )
    fake = _FakeProbeProvider(
        model_ids=["doubao-pro-32k", "doubao-lite-32k"],
        fail=False,
        supports_tools=True,
    )
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert fake.list_models_called is True
    assert fake.probe_called is True
    assert fake.probe_model == "ep-20240101000000-abcde"
    assert view.status == "active"
    assert view.message is not None
    assert "连通" in view.message and "模型组合" in view.message
    service._repo.update_status.assert_awaited_once_with("prov-1", "active")


async def test_test_provider_list_models_auth_error_is_hard_failure(service):
    from agentcore.core.errors import LLMAuthError

    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="error"),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-bad", base_url="https://api.deepseek.com", default_model=DEEPSEEK_V4_FLASH
    )
    fake = _FakeProbeProvider(
        list_models_error=LLMAuthError(provider_name="DeepSeek"),
        supports_tools=None,
    )
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert view.status == "error"
    assert "API Key" in (view.message or "")
    assert "模型组合" not in (view.message or "")
    assert fake.probe_called is False


async def test_test_provider_falls_back_to_probe_when_list_models_fails(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="active", supports_tools=True),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://api.openai.com/v1", default_model="gpt-4o"
    )
    fake = _FakeProbeProvider(
        list_models_error=LLMError("列出模型失败（HTTP 500）"),
        fail=False,
        supports_tools=True,
    )
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert fake.list_models_called is True
    assert fake.probe_called is True
    assert fake.probe_model == "gpt-4o"
    assert view.status == "active"
    assert view.message is not None
    assert "连通" in view.message and "模型组合" in view.message


async def test_test_provider_tools_failure_does_not_error_status(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="active", supports_tools=None),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://api.openai.com/v1", default_model="gpt-4o"
    )
    fake = _FakeProbeProvider(model_ids=["gpt-4o"], probe_tools_raises=True)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        view = await service.test_provider("u1", "prov-1")
    assert view.status == "active"
    assert view.message is not None
    assert "连通" in view.message and "模型组合" in view.message
    service._repo.update_supports_tools.assert_awaited_once_with("prov-1", None)


async def test_test_provider_logs_probe_failure(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x"),
            _row(api_key_enc=b"x", status="error"),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-bad", base_url="https://api.deepseek.com", default_model=DEEPSEEK_V4_FLASH
    )
    fake = _FakeProbeProvider(
        list_models_error=LLMError("no /models"),
        fail=True,
        supports_tools=None,
    )
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake),
        patch.object(service, "_encryptor", return_value=_enc()),
        capture_logs() as caps,
    ):
        view = await service.test_provider("u1", "prov-1")
    assert view.status == "error"
    assert view.message == "bad key"
    assert "模型组合" not in view.message
    failed = next(c for c in caps if c.get("event") == "llm_provider.test.failed")
    assert failed["provider_id"] == "prov-1"
    assert failed["model"] == DEEPSEEK_V4_FLASH
    assert "bad key" in failed["error"]


async def test_test_provider_empty_label_uses_generic_display_name(service):
    service._repo.get = AsyncMock(
        side_effect=[
            _row(api_key_enc=b"x", label=""),
            _row(api_key_enc=b"x", label="", status="active"),
        ]
    )
    creds = LLMCredentials(
        api_key="sk-abc", base_url="https://api.openai.com/v1", default_model="gpt-4o"
    )
    fake = _FakeProbeProvider(model_ids=["gpt-4o"], supports_tools=None)
    with (
        patch(
            "agentcore.llm.provider_service.resolve_provider_credentials",
            AsyncMock(return_value=creds),
        ),
        patch("agentcore.llm.provider_service.build_provider", return_value=fake) as build,
        patch.object(service, "_encryptor", return_value=_enc()),
    ):
        await service.test_provider("u1", "prov-1")
    assert build.call_args.kwargs.get("display_name") == "服务商"


async def test_test_provider_missing_raises(service):
    service._repo.get = AsyncMock(return_value=None)
    with pytest.raises(NotFoundError):
        await service.test_provider("u1", "missing")


async def test_delete_provider_retargets_main_to_fallback(service):
    service._repo.first_for_user = AsyncMock(
        return_value=_row(id="prov-2", default_model="m2")
    )
    await service.delete_provider("u1", "prov-1")
    service._profiles.retarget_main_provider.assert_awaited_once_with(
        "u1",
        from_provider_id="prov-1",
        to_provider_id="prov-2",
        to_model="m2",
        to_origin="byok",
    )
    service._profiles.clear_provider_refs.assert_awaited_once_with("u1", "prov-1")


async def test_delete_provider_retargets_to_platform_when_last(service):
    service._repo.first_for_user = AsyncMock(return_value=None)
    await service.delete_provider("u1", "prov-1")
    service._profiles.retarget_main_provider.assert_awaited_once_with(
        "u1",
        from_provider_id="prov-1",
        to_provider_id=None,
        to_model=DEEPSEEK_V4_FLASH,
        to_origin="platform",
    )


async def test_delete_provider_missing_raises(service):
    service._repo.delete = AsyncMock(return_value=False)
    with pytest.raises(NotFoundError):
        await service.delete_provider("u1", "missing")
