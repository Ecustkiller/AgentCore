"""Tests for Sub2API admin probe diagnostics."""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest

from agentcore.config import settings
from agentcore.llm import sub2api_probe as probe


def _reset_token_cache() -> None:
    probe._cached_token = None
    probe._token_expires_at = 0.0


@pytest.fixture(autouse=True)
def _clear_probe_cache():
    _reset_token_cache()
    yield
    _reset_token_cache()


def test_mask_email():
    assert probe._mask_email("elizabeth@gmail.com") == "eli***@gmail.com"
    assert probe._mask_email("ab@x.com") == "ab***@x.com"


def test_diagnose_account_quota_reset():
    future = datetime.now(UTC) + timedelta(hours=2)
    result = probe._diagnose_account(
        {
            "credentials": {"email": "user@example.com"},
            "extra": {"codex_5h_reset_at": future.isoformat()},
        }
    )
    assert "5 小时使用配额已用完" in result.diagnosis
    assert result.account_email_masked == "use***@example.com"


def test_diagnose_account_oauth_expired():
    past = datetime.now(UTC) - timedelta(hours=1)
    result = probe._diagnose_account(
        {
            "credentials": {"email": "user@example.com", "expires_at": past.isoformat()},
        }
    )
    assert "OAuth token 已过期" in result.diagnosis


def test_diagnose_account_upstream_rejection_masks_email():
    """诊断只进日志，但日志读者众多——兜底分支同样只写打码地址。"""
    result = probe._diagnose_account({"credentials": {"email": "elizabeth@gmail.com"}})
    assert "token 有效但被上游拒绝" in result.diagnosis
    assert "elizabeth@gmail.com" not in result.diagnosis
    assert "eli***@gmail.com" in result.diagnosis
    assert result.account_email_masked == "eli***@gmail.com"


def test_diagnose_account_missing_access_token():
    result = probe._diagnose_account(
        {
            "credentials": {"email": "user@example.com"},
            "credentials_status": {"has_access_token": False},
        }
    )
    assert result.diagnosis == "账号未绑定 access token"


@pytest.mark.asyncio
async def test_probe_returns_none_without_admin_url(monkeypatch):
    monkeypatch.setattr(settings, "sub2api_admin_url", "")
    assert await probe.probe_sub2api_diagnosis() is None


@pytest.mark.asyncio
async def test_probe_returns_diagnosis_on_503(monkeypatch):
    future = datetime.now(UTC) + timedelta(hours=1)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            return httpx.Response(
                200,
                json={"data": {"access_token": "admin-token", "expires_in": 3600}},
            )
        if request.url.path.endswith("/admin/accounts"):
            return httpx.Response(
                200,
                json={
                    "data": {
                        "items": [
                            {
                                "credentials": {"email": "eli@gmail.com"},
                                "extra": {"codex_5h_reset_at": future.isoformat()},
                            }
                        ]
                    }
                },
            )
        return httpx.Response(404)

    monkeypatch.setattr(settings, "sub2api_admin_url", "http://sub2api.test")
    monkeypatch.setattr(settings, "sub2api_admin_email", "admin@test")
    monkeypatch.setattr(settings, "sub2api_admin_password", "secret")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def _client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(probe.httpx, "AsyncClient", _client_factory)

    diagnosis = await probe.probe_sub2api_diagnosis()
    assert diagnosis is not None
    assert "5 小时使用配额已用完" in diagnosis


@pytest.mark.asyncio
async def test_probe_fail_open_on_admin_unreachable(monkeypatch):
    monkeypatch.setattr(settings, "sub2api_admin_url", "http://sub2api.test")
    monkeypatch.setattr(settings, "sub2api_admin_email", "admin@test")
    monkeypatch.setattr(settings, "sub2api_admin_password", "secret")

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, content=b"down")

    transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def _client_factory(*args, **kwargs):
        kwargs["transport"] = transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(probe.httpx, "AsyncClient", _client_factory)

    assert await probe.probe_sub2api_diagnosis() is None


def _sub2api_handler(account: dict) -> Callable[[httpx.Request], httpx.Response]:
    """Admin API that authenticates, returns ``account``, and 503s the model call."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/auth/login"):
            return httpx.Response(
                200,
                json={"data": {"access_token": "admin-token", "expires_in": 3600}},
            )
        if request.url.path.endswith("/admin/accounts"):
            return httpx.Response(200, json={"data": {"items": [account]}})
        return httpx.Response(503, content=b"upstream unavailable")

    return handler


async def _platform_503(monkeypatch, account: dict):
    """Drive a platform-mode 503 turn against ``account``; return (error, log spy)."""
    from agentcore.core.errors import LLMUpstreamError
    from agentcore.llm.provider import openai_compatible
    from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
    from agentcore.llm.provider.protocol import LLMMessage, LLMRequest
    from tests.conftest import LogSpy

    handler = _sub2api_handler(account)

    monkeypatch.setattr(settings, "billing_mode", "platform")
    monkeypatch.setattr(settings, "sub2api_admin_url", "http://sub2api.test")
    monkeypatch.setattr(settings, "sub2api_admin_email", "admin@test")
    monkeypatch.setattr(settings, "sub2api_admin_password", "secret")

    spy = LogSpy()
    monkeypatch.setattr(openai_compatible, "logger", spy)

    provider = OpenAICompatibleProvider(name="platform", api_key="k", base_url="http://llm.test/v1")
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url="http://llm.test/v1", transport=httpx.MockTransport(handler)
    )

    probe_transport = httpx.MockTransport(handler)
    original_client = httpx.AsyncClient

    def _probe_client_factory(*args, **kwargs):
        kwargs["transport"] = probe_transport
        return original_client(*args, **kwargs)

    monkeypatch.setattr(probe.httpx, "AsyncClient", _probe_client_factory)

    req = LLMRequest(messages=[LLMMessage(role="user", content="hi")], model="gpt-4o")
    try:
        with pytest.raises(LLMUpstreamError) as ei:
            await provider.complete(req)
        return ei.value, spy
    finally:
        await provider.close()


@pytest.mark.asyncio
async def test_platform_503_user_face_carries_no_operator_account(monkeypatch):
    """平台模式 = 用户没有自己的 key，运营方账号诊断一个字都不该进用户面。

    曾经这四句（OAuth 过期需重新登录 ChatGPT / 账号 xxx@gmail.com 被上游拒绝 …）
    被拼进 503 气泡，把运营方的事说成用户的事。
    """
    from agentcore.llm.errors import error_context_from

    err, spy = await _platform_503(
        monkeypatch,
        {
            # No expiry / no quota reset / token present → the fallback branch.
            "credentials": {"email": "elizabeth@gmail.com"},
            "credentials_status": {"has_access_token": True},
        },
    )

    # 探针确实跑了并给出了当年泄露的那句——不是探针没跑造成的假绿。
    logged = [kw.get("sub2api_diagnosis", "") for _, kw in spy.events]
    assert any("token 有效但被上游拒绝" in text for text in logged)

    assert err.message == "上游模型服务暂时不可用（503），请稍后再试"
    for leaked in ("诊断", "token 有效但被上游拒绝", "elizabeth@gmail.com", "eli***@gmail.com"):
        assert leaked not in err.message
    assert "sub2api" not in str(err.details)
    assert "elizabeth" not in str(err.details)

    # SSE / REST error context is user-visible too — nothing rides there either.
    ctx = error_context_from(err) or {}
    assert not any(key.startswith("sub2api") for key in ctx)
    assert "elizabeth" not in str(ctx)


@pytest.mark.asyncio
async def test_platform_503_diagnosis_reaches_the_log_surface(monkeypatch):
    """诊断没被删掉，只是换了去处：运维在日志里仍拿得到。"""
    past = datetime.now(UTC) - timedelta(hours=1)

    err, spy = await _platform_503(
        monkeypatch,
        {"credentials": {"email": "elizabeth@gmail.com", "expires_at": past.isoformat()}},
    )

    diagnosed = [
        kw
        for event, kw in spy.events
        if event == "llm.upstream_error" and kw.get("sub2api_diagnosis")
    ]
    assert len(diagnosed) == 1
    assert "OAuth token 已过期" in diagnosed[0]["sub2api_diagnosis"]
    assert diagnosed[0]["sub2api_account"] == "eli***@gmail.com"
    # …and the same run still says nothing about it to the user.
    assert "OAuth" not in err.message
    assert "ChatGPT" not in err.message
