"""Lock eval credential priority: EVAL env → dev BYOK → PLATFORM (last)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from agentcore.evals import harness
from agentcore.llm.credentials import LLMCredentials


@pytest.fixture(autouse=True)
def _clear_eval_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "EVAL_DEEPSEEK_API_KEY",
        "EVAL_DEEPSEEK_BASE_URL",
        "EVAL_DEEPSEEK_MODEL",
        "DEV_USERNAME",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.asyncio
async def test_eval_credentials_prefers_eval_env_over_byok_and_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("EVAL_DEEPSEEK_API_KEY", "sk-eval-only")
    monkeypatch.setenv("EVAL_DEEPSEEK_BASE_URL", "https://eval.example/v1")
    monkeypatch.setenv("EVAL_DEEPSEEK_MODEL", "eval-model")
    monkeypatch.setattr(
        harness,
        "_credentials_from_dev_byok",
        AsyncMock(
            return_value=LLMCredentials(
                api_key="sk-byok",
                base_url="https://opencode.ai/zen/v1",
                default_model="deepseek-v4-flash",
                source="user",
            )
        ),
    )
    monkeypatch.setattr(
        "agentcore.llm.resolve.platform_llm_credentials",
        lambda model=None: LLMCredentials(
            api_key="sk-platform",
            base_url="https://platform.example/v1",
            default_model="plat-model",
            source="platform",
        ),
    )

    creds = await harness.eval_credentials()
    assert creds.api_key == "sk-eval-only"
    assert creds.base_url == "https://eval.example/v1"
    assert creds.default_model == "eval-model"


@pytest.mark.asyncio
async def test_eval_credentials_uses_dev_byok_before_platform(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byok = LLMCredentials(
        api_key="sk-dev-byok",
        base_url="https://opencode.ai/zen/v1",
        default_model="deepseek-v4-flash-free",
        source="user",
    )
    monkeypatch.setattr(harness, "_credentials_from_dev_byok", AsyncMock(return_value=byok))
    monkeypatch.setattr(
        "agentcore.llm.resolve.platform_llm_credentials",
        lambda model=None: LLMCredentials(
            api_key="sk-platform",
            base_url="https://platform.example/v1",
            default_model="plat-model",
            source="platform",
        ),
    )

    creds = await harness.eval_credentials()
    assert creds.api_key == "sk-dev-byok"
    assert "opencode.ai" in creds.base_url


@pytest.mark.asyncio
async def test_eval_credentials_platform_last_emits_warning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(harness, "_credentials_from_dev_byok", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "agentcore.llm.resolve.platform_llm_credentials",
        lambda model=None: LLMCredentials(
            api_key="sk-platform",
            base_url="https://platform.example/v1",
            default_model="plat-model",
            source="platform",
        ),
    )
    warn = MagicMock()
    monkeypatch.setattr(harness.logger, "warning", warn)

    creds = await harness.eval_credentials()

    assert creds.api_key == "sk-platform"
    warn.assert_called_once()
    assert warn.call_args.args[0] == "evals.credentials_using_platform"


@pytest.mark.asyncio
async def test_eval_credentials_missing_raises_with_seed_hint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(harness, "_credentials_from_dev_byok", AsyncMock(return_value=None))
    monkeypatch.setattr(
        "agentcore.llm.resolve.platform_llm_credentials",
        lambda model=None: None,
    )

    with pytest.raises(RuntimeError, match="seed_dev_user") as ei:
        await harness.eval_credentials()
    assert "OpenCode" in str(ei.value)
    assert "PLATFORM_API_KEY" in str(ei.value)


@pytest.mark.asyncio
async def test_credentials_from_dev_byok_skips_platform_sourced_resolve(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """resolve_credentials returning platform must not count as local BYOK."""
    user = MagicMock()
    user.user_id = "u-dev"

    session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=None)

    factory = MagicMock(return_value=session)
    monkeypatch.setattr("agentcore.db.base.async_session_factory", factory)
    monkeypatch.setattr(
        "agentcore.db.repositories.UserRepository",
        lambda _s: MagicMock(get_by_username=AsyncMock(return_value=user)),
    )
    monkeypatch.setattr(
        "agentcore.llm.resolve.resolve_credentials",
        AsyncMock(
            return_value=LLMCredentials(
                api_key="sk-platform",
                base_url="https://platform.example/v1",
                default_model="plat",
                source="platform",
            )
        ),
    )

    assert await harness._credentials_from_dev_byok() is None


def test_eval_credentials_sync_wrapper_matches_async(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    byok = LLMCredentials(
        api_key="sk-sync",
        base_url="https://opencode.ai/zen/v1",
        default_model="m",
        source="user",
    )
    monkeypatch.setattr(harness, "_credentials_from_dev_byok", AsyncMock(return_value=byok))
    monkeypatch.setattr(
        "agentcore.llm.resolve.platform_llm_credentials",
        lambda model=None: None,
    )

    creds = harness._eval_credentials()
    assert creds.api_key == "sk-sync"
    assert "opencode.ai" in creds.base_url
