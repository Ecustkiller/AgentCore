"""Platform credential pool: pick, env fallback, per-model override still wins."""

from __future__ import annotations

from agentcore.billing.preference import is_platform_available
from agentcore.config import settings
from agentcore.llm.platform_pool import (
    PlatformPoolMember,
    pick_enabled_platform_pool_member,
    replace_platform_pool_snapshot,
)
from agentcore.llm.resolve import platform_llm_credentials

_GO = "https://opencode.ai/zen/go/v1"
_ZEN = "https://opencode.ai/zen/v1"


def _member(
    *,
    cred_id: str = "11111111-1111-1111-1111-111111111111",
    enabled: bool = True,
    api_key: str = "sk-pool-a",
    base_url: str = _GO,
    subscription_day: int = 18,
    label: str = "Go-A",
) -> PlatformPoolMember:
    return PlatformPoolMember(
        id=cred_id,
        label=label,
        api_key=api_key,
        base_url=base_url,
        subscription_day=subscription_day,
        enabled=enabled,
    )


def test_empty_pool_falls_back_to_env(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-env")
    monkeypatch.setattr(settings, "platform_base_url", _ZEN)
    monkeypatch.setattr(settings, "platform_model", "deepseek-v4-flash")
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    replace_platform_pool_snapshot(())
    creds = platform_llm_credentials()
    assert creds is not None
    assert creds.api_key == "sk-env"
    assert creds.base_url == _ZEN
    assert creds.source == "platform"
    assert creds.platform_credential_id
    assert creds.api_key not in creds.platform_credential_id


def test_empty_pool_without_env_is_none(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    replace_platform_pool_snapshot(())
    assert platform_llm_credentials() is None
    assert is_platform_available() is False


def test_enabled_member_is_picked_with_bound_base_url(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-env")
    monkeypatch.setattr(settings, "platform_base_url", _ZEN)
    monkeypatch.setattr(settings, "platform_model", "deepseek-v4-flash")
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    member = _member()
    replace_platform_pool_snapshot((member,))
    creds = platform_llm_credentials()
    assert creds is not None
    assert creds.api_key == "sk-pool-a"
    assert creds.base_url == _GO  # bound; not the global Zen URL
    assert creds.platform_credential_id == member.id
    assert pick_enabled_platform_pool_member() is member


def test_disabled_member_skipped_falls_back_to_env(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-env")
    monkeypatch.setattr(settings, "platform_base_url", _ZEN)
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    replace_platform_pool_snapshot((_member(enabled=False),))
    creds = platform_llm_credentials()
    assert creds is not None
    assert creds.api_key == "sk-env"
    assert creds.base_url == _ZEN


def test_first_enabled_of_two_is_stable(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    a = _member(cred_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", api_key="sk-a")
    b = _member(cred_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", api_key="sk-b")
    replace_platform_pool_snapshot((a, b))
    creds = platform_llm_credentials()
    assert creds is not None
    assert creds.api_key == "sk-a"
    assert creds.platform_credential_id == a.id


def test_per_model_override_key_still_wins_over_pool(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "sk-env")
    monkeypatch.setattr(settings, "platform_base_url", _ZEN)
    monkeypatch.setattr(
        settings,
        "platform_model_credentials",
        '{"relay-b": {"api_key": "sk-relay", "base_url": "https://relay.example/v1"}}',
    )
    replace_platform_pool_snapshot((_member(),))
    pool = platform_llm_credentials()
    assert pool is not None
    assert pool.api_key == "sk-pool-a"
    override = platform_llm_credentials(model="relay-b")
    assert override is not None
    assert override.api_key == "sk-relay"
    assert override.base_url == "https://relay.example/v1"
    assert override.platform_credential_id != pool.platform_credential_id


def test_is_platform_available_with_pool_only(monkeypatch):
    monkeypatch.setattr(settings, "platform_api_key", "")
    monkeypatch.setattr(settings, "platform_model_credentials", "")
    replace_platform_pool_snapshot((_member(),))
    assert is_platform_available() is True
    replace_platform_pool_snapshot((_member(enabled=False),))
    assert is_platform_available() is False
