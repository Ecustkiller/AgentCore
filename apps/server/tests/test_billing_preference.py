"""Unit tests for per-user billing preference resolution."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agentcore.billing.preference import (
    default_billing_preference,
    is_platform_available,
    resolve_effective_billing_mode,
    validate_billing_preference,
)
from agentcore.config import settings
from agentcore.core.errors import PlatformBillingUnavailableError, ValidationError
from agentcore.llm.key_service import LlmKeyService
from agentcore.llm.resolve import resolve_model_config


def _user(*, billing_preference: str = "byok"):
    return MagicMock(billing_preference=billing_preference)


def test_default_billing_preference_follows_env(monkeypatch):
    monkeypatch.setattr(settings, "billing_mode", "platform")
    assert default_billing_preference() == "platform"
    monkeypatch.setattr(settings, "billing_mode", "byok")
    assert default_billing_preference() == "byok"


def test_resolve_effective_billing_mode_uses_user_column():
    assert resolve_effective_billing_mode(_user(billing_preference="platform")) == "platform"


def test_is_platform_available_requires_operator_key(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    assert is_platform_available() is False
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    assert is_platform_available() is True


def test_validate_billing_preference_rejects_unknown():
    with pytest.raises(ValueError):
        validate_billing_preference("credits")


@pytest.mark.asyncio
async def test_resolve_model_config_platform_user(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(settings, "platform_model", "gpt-5")
    session = MagicMock()
    user = _user(billing_preference="platform")
    with patch(
        "agentcore.db.repositories.UserRepository"
    ) as repo_cls:
        repo_cls.return_value.get_by_id = AsyncMock(return_value=user)
        cfg = await resolve_model_config(session, "u1", "chat")
    assert cfg is not None
    assert cfg.source == "platform"
    assert cfg.model == "gpt-5"


@pytest.mark.asyncio
async def test_resolve_model_config_byok_user_without_key(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    session = MagicMock()
    user = _user(billing_preference="byok")
    with (
        patch("agentcore.db.repositories.UserRepository") as repo_cls,
        patch(
            "agentcore.llm.resolve.resolve_user_llm_credentials",
            AsyncMock(return_value=None),
        ),
    ):
        repo_cls.return_value.get_by_id = AsyncMock(return_value=user)
        cfg = await resolve_model_config(session, "u1", "chat")
    assert cfg is None


@pytest.mark.asyncio
async def test_set_billing_preference_rejects_unavailable_platform(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    service = LlmKeyService(MagicMock())
    service._users = MagicMock()
    with pytest.raises(PlatformBillingUnavailableError):
        await service.set_billing_preference("u1", "platform")


@pytest.mark.asyncio
async def test_set_billing_preference_persists_choice(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-platform")
    service = LlmKeyService(MagicMock())
    service._users = MagicMock()
    service._users.set_billing_preference = AsyncMock(return_value=_user(billing_preference="platform"))
    service._users.get_by_id = AsyncMock(return_value=_user(billing_preference="platform"))
    service._repo.get_by_user_id = AsyncMock(return_value=None)
    status = await service.set_billing_preference("u1", "platform")
    assert status.billing_preference == "platform"
    assert status.billing_mode == "platform"


@pytest.mark.asyncio
async def test_set_billing_preference_rejects_invalid():
    service = LlmKeyService(MagicMock())
    with pytest.raises(ValidationError):
        await service.set_billing_preference("u1", "subscription")
