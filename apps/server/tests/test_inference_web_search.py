"""Unit tests for ``POST /v1/inference/web_search`` (sidecar cloud search fallback)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Annotated

import httpx
import pytest
from fastapi import Header
from httpx import ASGITransport
from starlette.requests import Request

from agentcore.api.routes import inference
from agentcore.api.routes.inference import web_search as web_search_mod
from agentcore.api.routes.inference.token import inference_user
from agentcore.api.routes.inference.web_search import (
    InferenceWebSearchRequest,
    inference_web_search,
)
from agentcore.core.errors import AuthenticationError, RateLimitedError
from agentcore.llm.credentials import (
    INFERENCE_CONVERSATION_HEADER,
    INFERENCE_MESSAGE_HEADER,
    INFERENCE_TRACE_HEADER,
)
from agentcore.main import app
from agentcore.security import create_access_token, create_inference_token
from agentcore.security.tokens import decode_inference_token
from agentcore.tools.builtin.web.search_backend import SearchResult

pytestmark = pytest.mark.anyio


class _FakeUserRepo:
    def __init__(self, user):
        self._user = user

    async def get_by_id(self, _user_id):
        return self._user


class _FakeBackend:
    def __init__(
        self, results: list[SearchResult] | None = None, *, error: Exception | None = None
    ):
        self._results = results or []
        self._error = error
        self.calls: list[dict] = []

    async def search(self, query, max_results=5, on_phase=None, *, language=None):
        self.calls.append(
            {"query": query, "max_results": max_results, "language": language}
        )
        if self._error is not None:
            raise self._error
        return self._results


def _starlette_request(*, headers: dict[str, str] | None = None) -> Request:
    hdrs = [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/inference/web_search",
            "headers": hdrs,
        }
    )


def _noop_proxy_rate_limit(monkeypatch):
    """Isolate success-path tests from the shared user-message limiter."""

    async def _noop(_user_id, *, message_id=None, **_kw):
        return None

    monkeypatch.setattr(web_search_mod, "enforce_inference_proxy_rate_limit", _noop)


async def test_inference_web_search_returns_results(monkeypatch):
    _noop_proxy_rate_limit(monkeypatch)
    backend = _FakeBackend(
        [
            SearchResult(title="Alpha", url="https://a.example/", snippet="a"),
            SearchResult(title="Beta", url="https://b.example/", snippet="b"),
        ]
    )
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)
    resp = await inference_web_search(
        InferenceWebSearchRequest(query="  hello world  ", max_results=3, language="zh"),
        _starlette_request(
            headers={
                INFERENCE_CONVERSATION_HEADER: "conv-1",
                INFERENCE_TRACE_HEADER: "trace-1",
            }
        ),
        user=SimpleNamespace(user_id="u1", status="active"),  # type: ignore[arg-type]
    )
    assert resp.source == "cloud"
    assert [r.model_dump() for r in resp.results] == [
        {"title": "Alpha", "url": "https://a.example/", "snippet": "a"},
        {"title": "Beta", "url": "https://b.example/", "snippet": "b"},
    ]
    assert backend.calls == [
        {"query": "hello world", "max_results": 3, "language": "zh"}
    ]


async def test_inference_web_search_backend_error_is_clean_502(monkeypatch):
    _noop_proxy_rate_limit(monkeypatch)
    backend = _FakeBackend(error=RuntimeError("secret stack TRACEBACK /api/key=sk-leak"))
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)
    resp = await inference_web_search(
        InferenceWebSearchRequest(query="q"),
        _starlette_request(),
        user=SimpleNamespace(user_id="u1"),  # type: ignore[arg-type]
    )
    assert resp.status_code == 502
    body = resp.body.decode()
    assert "云端搜索暂时不可用" in body
    assert "INTERNAL_ERROR" in body
    assert "TRACEBACK" not in body
    assert "sk-leak" not in body
    assert "secret stack" not in body


async def test_inference_web_search_rejects_missing_token():
    with pytest.raises(AuthenticationError):
        await inference.inference_user(authorization=None, user_repo=_FakeUserRepo(None))


async def test_inference_web_search_rejects_access_token():
    with pytest.raises(AuthenticationError):
        await inference.inference_user(
            authorization=f"Bearer {create_access_token('u1', audience='product')}",
            user_repo=_FakeUserRepo(SimpleNamespace(user_id="u1", status="active")),
        )


async def test_inference_web_search_http_auth_and_success(monkeypatch):
    """ASGI: no/bad token → 401; valid inference token → 200 with results."""
    _noop_proxy_rate_limit(monkeypatch)
    backend = _FakeBackend(
        [SearchResult(title="T", url="https://t.example/", snippet="s")]
    )
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)

    async def _override_inference_user(
        authorization: Annotated[str | None, Header()] = None,
    ):
        if not authorization or not authorization.lower().startswith("bearer "):
            raise AuthenticationError("Missing inference token")
        user_id = decode_inference_token(authorization.split(" ", 1)[1].strip())
        return SimpleNamespace(user_id=user_id, status="active")

    app.dependency_overrides[inference_user] = _override_inference_user
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            missing = await client.post("/v1/inference/web_search", json={"query": "q"})
            assert missing.status_code == 401

            access = await client.post(
                "/v1/inference/web_search",
                json={"query": "q"},
                headers={
                    "Authorization": (
                        f"Bearer {create_access_token('u1', audience='product')}"
                    )
                },
            )
            assert access.status_code == 401

            ok = await client.post(
                "/v1/inference/web_search",
                json={"query": "q", "max_results": 2},
                headers={
                    "Authorization": f"Bearer {create_inference_token('u1')}",
                    INFERENCE_CONVERSATION_HEADER: "c1",
                    INFERENCE_TRACE_HEADER: "t1",
                },
            )
            assert ok.status_code == 200
            payload = ok.json()
            assert payload["source"] == "cloud"
            assert payload["results"] == [
                {"title": "T", "url": "https://t.example/", "snippet": "s"}
            ]
    finally:
        app.dependency_overrides.pop(inference_user, None)


async def test_inference_web_search_http_backend_502(monkeypatch):
    _noop_proxy_rate_limit(monkeypatch)
    backend = _FakeBackend(error=RuntimeError("internal boom TRACEBACK"))
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)

    async def _ok_user(authorization: Annotated[str | None, Header()] = None):
        return SimpleNamespace(user_id="u1", status="active")

    app.dependency_overrides[inference_user] = _ok_user
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.post(
                "/v1/inference/web_search",
                json={"query": "q"},
                headers={"Authorization": f"Bearer {create_inference_token('u1')}"},
            )
            assert r.status_code == 502
            body = r.text
            assert "云端搜索暂时不可用" in body
            assert "TRACEBACK" not in body
            assert "internal boom" not in body
    finally:
        app.dependency_overrides.pop(inference_user, None)


async def test_inference_web_search_calls_same_proxy_rate_limit(monkeypatch):
    """Route reuses enforce_inference_proxy_rate_limit with message_id when present."""
    calls: list[dict] = []

    async def _capture(user_id, *, message_id=None, **_kw):
        calls.append({"user_id": user_id, "message_id": message_id})

    monkeypatch.setattr(web_search_mod, "enforce_inference_proxy_rate_limit", _capture)
    backend = _FakeBackend(
        [SearchResult(title="T", url="https://t.example/", snippet="s")]
    )
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)

    await inference_web_search(
        InferenceWebSearchRequest(query="q"),
        _starlette_request(headers={INFERENCE_MESSAGE_HEADER: "msg-42"}),
        user=SimpleNamespace(user_id="u-rate", status="active"),  # type: ignore[arg-type]
    )
    assert calls == [{"user_id": "u-rate", "message_id": "msg-42"}]

    calls.clear()
    await inference_web_search(
        InferenceWebSearchRequest(query="q2"),
        _starlette_request(),
        user=SimpleNamespace(user_id="u-rate", status="active"),  # type: ignore[arg-type]
    )
    assert calls == [{"user_id": "u-rate", "message_id": None}]


async def test_inference_web_search_http_rate_limited_is_429(monkeypatch):
    """Over-limit matches proxy: RateLimitedError → HTTP 429 (no soft-warn path)."""
    backend = _FakeBackend(
        [SearchResult(title="T", url="https://t.example/", snippet="s")]
    )
    monkeypatch.setattr(web_search_mod, "get_search_backend", lambda: backend)

    async def _block(_user_id, *, message_id=None, **_kw):
        raise RateLimitedError("操作过于频繁，请约 30 秒后再发送。", retry_after=30.0)

    monkeypatch.setattr(web_search_mod, "enforce_inference_proxy_rate_limit", _block)

    async def _ok_user(authorization: Annotated[str | None, Header()] = None):
        return SimpleNamespace(user_id="u1", status="active")

    app.dependency_overrides[inference_user] = _ok_user
    try:
        transport = ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            r = await client.post(
                "/v1/inference/web_search",
                json={"query": "q"},
                headers={
                    "Authorization": f"Bearer {create_inference_token('u1')}",
                    INFERENCE_MESSAGE_HEADER: "msg-1",
                },
            )
            assert r.status_code == 429
            assert r.headers.get("Retry-After") == "30"
            body = r.json()
            assert body["error"]["code"] == "RATE_LIMITED"
            assert "过于频繁" in body["error"]["message"]
            assert backend.calls == []
    finally:
        app.dependency_overrides.pop(inference_user, None)
