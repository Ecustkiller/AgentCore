"""Unit tests for the sidecar cloud inference proxy (双模式工作区 §一.1 / Slice 4a).

The proxy is the single choke point that lets a local sidecar reach DeepSeek
WITHOUT the platform key on the user's machine, runs the same spend gate as a
cloud turn, and meters real usage server-side (so platform billing can't be
under-reported by the client). Collaborators are faked (mirroring
``test_local_turn``) so the control flow is asserted without a DB / real LLM; the
HTTP forwarding is driven through ``httpx.MockTransport``.

Covered:

* token mint → decode roundtrip, and that an ``access`` token is refused as the
  wrong type (the two token kinds can never be confused);
* the bearer dependency rejects a missing / wrong-type token and resolves a valid one;
* the spend gate resolves BYOK vs platform credentials and refuses correctly;
* a proxied call's real usage is priced + recorded under the conversation
  (message_id NULL), skipped when the conversation header is absent, and a ledger
  failure never escapes;
* unary + streaming forwarding pass the upstream body/status through and tee the
  final usage to record spend exactly once.
"""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from agentcore.api.routes import inference
from agentcore.core.errors import AuthenticationError, BYOKKeyMissingError, QuotaExceededError
from agentcore.llm.byok import LLMCredentials
from agentcore.security import create_access_token, create_inference_token

pytestmark = pytest.mark.anyio


# --- token mint / verify -----------------------------------------------------


def test_inference_token_roundtrip():
    token = create_inference_token("user-1")
    assert inference.decode_inference_token(token) == "user-1"


def test_inference_token_rejects_access_token():
    """An access token must NOT authorize the inference proxy (wrong type)."""
    access = create_access_token("user-1")
    with pytest.raises(AuthenticationError):
        inference.decode_inference_token(access)


def test_inference_token_rejects_expired():
    expired = create_inference_token("user-1", expires_delta=timedelta(minutes=-1))
    with pytest.raises(AuthenticationError):
        inference.decode_inference_token(expired)


def test_access_decode_rejects_inference_token():
    """Symmetry: the cookie API's decoder must also refuse an inference token."""
    from agentcore.security import decode_access_token

    token = create_inference_token("user-1")
    with pytest.raises(AuthenticationError):
        decode_access_token(token)


# --- bearer auth dependency --------------------------------------------------


class _FakeUserRepo:
    def __init__(self, user):
        self._user = user

    async def get_by_id(self, _user_id):
        return self._user


async def test_inference_user_resolves_valid_token():
    user = SimpleNamespace(user_id="u1", status="active")
    resolved = await inference.inference_user(
        authorization=f"Bearer {create_inference_token('u1')}",
        user_repo=_FakeUserRepo(user),
    )
    assert resolved is user


async def test_inference_user_rejects_missing_header():
    with pytest.raises(AuthenticationError):
        await inference.inference_user(authorization=None, user_repo=_FakeUserRepo(None))


async def test_inference_user_rejects_access_token():
    with pytest.raises(AuthenticationError):
        await inference.inference_user(
            authorization=f"Bearer {create_access_token('u1')}",
            user_repo=_FakeUserRepo(SimpleNamespace(user_id="u1", status="active")),
        )


async def test_inference_user_rejects_inactive_user():
    with pytest.raises(AuthenticationError):
        await inference.inference_user(
            authorization=f"Bearer {create_inference_token('u1')}",
            user_repo=_FakeUserRepo(SimpleNamespace(user_id="u1", status="disabled")),
        )


# --- credential resolution + spend gate --------------------------------------


async def test_resolve_credentials_byok_returns_user_key(monkeypatch):
    monkeypatch.setattr(inference.settings, "billing_mode", "byok")

    async def _fake_resolve(_session, _user_id):
        return LLMCredentials(api_key="sk-user", base_url="https://api.deepseek.com")

    monkeypatch.setattr(inference, "resolve_user_llm_credentials", _fake_resolve)
    creds = await inference._resolve_inference_credentials(
        None, None, SimpleNamespace(user_id="u1")
    )
    assert creds.api_key == "sk-user"


async def test_resolve_credentials_byok_missing_key_refuses(monkeypatch):
    monkeypatch.setattr(inference.settings, "billing_mode", "byok")

    async def _fake_resolve(_session, _user_id):
        return None

    monkeypatch.setattr(inference, "resolve_user_llm_credentials", _fake_resolve)
    with pytest.raises(BYOKKeyMissingError):
        await inference._resolve_inference_credentials(
            None, None, SimpleNamespace(user_id="u1")
        )


async def test_resolve_credentials_platform_enforces_quota_then_uses_global(monkeypatch):
    monkeypatch.setattr(inference.settings, "billing_mode", "platform")
    monkeypatch.setattr(inference.settings, "deepseek_api_key", "sk-platform")
    monkeypatch.setattr(inference.settings, "deepseek_base_url", "https://api.deepseek.com")
    monkeypatch.setattr(
        inference, "QuotaLimits", SimpleNamespace(for_user=lambda _u: "LIMITS")
    )
    seen = {}

    async def _fake_enforce(cost_repo, user_id, *, limits):
        seen["user_id"] = user_id
        seen["limits"] = limits

    monkeypatch.setattr(inference, "enforce_quota", _fake_enforce)
    creds = await inference._resolve_inference_credentials(
        None, "COST_REPO", SimpleNamespace(user_id="u1")
    )
    assert creds.api_key == "sk-platform"
    assert seen == {"user_id": "u1", "limits": "LIMITS"}


async def test_resolve_credentials_platform_quota_exceeded_propagates(monkeypatch):
    monkeypatch.setattr(inference.settings, "billing_mode", "platform")
    monkeypatch.setattr(
        inference, "QuotaLimits", SimpleNamespace(for_user=lambda _u: "LIMITS")
    )

    async def _fake_enforce(_cost_repo, _user_id, *, limits):
        raise QuotaExceededError("over budget")

    monkeypatch.setattr(inference, "enforce_quota", _fake_enforce)
    with pytest.raises(QuotaExceededError):
        await inference._resolve_inference_credentials(
            None, None, SimpleNamespace(user_id="u1")
        )


# --- authoritative metering --------------------------------------------------


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _capture_record_runs(monkeypatch, *, raises: bool = False):
    """Fake the ledger write, capturing record_runs calls into the returned list."""
    calls: list = []

    class _FakeCostRepo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            if raises:
                raise RuntimeError("ledger boom")
            calls.append(kw)
            return len(kw.get("runs") or [])

    monkeypatch.setattr(inference, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(inference, "CostEventRepository", _FakeCostRepo)
    return calls


async def test_record_proxy_spend_prices_and_records(monkeypatch):
    calls = _capture_record_runs(monkeypatch)
    usage = inference._usage_from_deepseek(
        {
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "prompt_cache_hit_tokens": 400,
            "prompt_cache_miss_tokens": 600,
        }
    )
    await inference._record_proxy_spend(
        user_id="u1", conversation_id="c1", model="deepseek-v4-flash", usage=usage
    )

    assert len(calls) == 1
    kw = calls[0]
    assert kw["user_id"] == "u1"
    assert kw["conversation_id"] == "c1"
    # Off-turn shape: lands in account/conversation totals, out of per-message payroll.
    assert kw["message_id"] is None
    (row,) = kw["runs"]
    assert row["role"] == inference.ROLE_CAPTAIN
    # Priced server-side off the real usage (not trusted from the client).
    assert row["cost_total_nano"] > 0
    assert row["tokens"]["input"] == 1000


async def test_record_proxy_spend_skips_without_conversation(monkeypatch):
    calls = _capture_record_runs(monkeypatch)
    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id=None,
        model="deepseek-v4-flash",
        usage=inference._usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
    )
    assert calls == []  # no conversation → no row (can't satisfy the NOT NULL column)


async def test_record_proxy_spend_swallows_ledger_failure(monkeypatch):
    _capture_record_runs(monkeypatch, raises=True)
    # Must not raise — a ledger failure can't break a turn whose answer already streamed.
    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=inference._usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
    )


def test_usage_from_deepseek_maps_fields():
    usage = inference._usage_from_deepseek(
        {
            "prompt_tokens": 30,
            "completion_tokens": 12,
            "completion_tokens_details": {"reasoning_tokens": 4},
            "prompt_cache_hit_tokens": 10,
            "prompt_cache_miss_tokens": 20,
        }
    )
    assert usage.input_tokens == 30
    assert usage.output_tokens == 12
    assert usage.reasoning_tokens == 4
    assert usage.cache_hit_tokens == 10
    assert usage.cache_miss_tokens == 20


# --- forwarding (httpx.MockTransport) ----------------------------------------


async def test_forward_unary_passes_through_and_records(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference, "_record_proxy_spend", _fake_spend)

    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/v1/chat/completions")
        return httpx.Response(
            200,
            json={
                "model": "deepseek-v4-flash",
                "choices": [{"message": {"content": "hi"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    client = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(_handler)
    )
    resp = await inference._forward_unary(
        client, {"model": "deepseek-v4-flash"}, user_id="u1", conversation_id="c1"
    )

    assert resp.status_code == 200
    assert b'"content":"hi"' in resp.body
    # Spend recorded once, off the upstream usage + model.
    assert len(spend) == 1
    assert spend[0]["conversation_id"] == "c1"
    assert spend[0]["model"] == "deepseek-v4-flash"
    assert spend[0]["usage"].output_tokens == 5


async def test_forward_unary_passes_error_status_through(monkeypatch):
    spend: list = []
    monkeypatch.setattr(
        inference, "_record_proxy_spend", lambda **kw: spend.append(kw)
    )

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "insufficient balance"})

    client = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(_handler)
    )
    resp = await inference._forward_unary(
        client, {"model": "deepseek-v4-flash"}, user_id="u1", conversation_id="c1"
    )

    # Upstream status passes through so the provider keeps its 402 handling; a
    # non-200 records no spend (nothing was actually consumed).
    assert resp.status_code == 402
    assert spend == []


async def test_forward_stream_relays_and_records(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        async def _body():
            yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            yield (
                b'data: {"choices":[{"delta":{}}],'
                b'"usage":{"prompt_tokens":10,"completion_tokens":5},'
                b'"model":"deepseek-v4-flash"}\n\n'
            )
            yield b"data: [DONE]\n\n"

        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=_body()
        )

    client = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(_handler)
    )
    resp = await inference._forward_stream(
        client, {"model": "deepseek-v4-flash", "stream": True}, user_id="u1", conversation_id="c1"
    )

    collected = ""
    async for chunk in resp.body_iterator:
        collected += chunk

    # The content delta + DONE sentinel are relayed verbatim to the sidecar.
    assert '"content":"hi"' in collected
    assert "[DONE]" in collected
    # The final usage chunk is teed → spend recorded once, after the stream ends.
    assert len(spend) == 1
    assert spend[0]["usage"].output_tokens == 5
    assert spend[0]["model"] == "deepseek-v4-flash"


# --- trace stitching (打通气泡↔日志) -----------------------------------------


async def test_record_proxy_spend_binds_trace_into_log_context(monkeypatch):
    """The spend log must carry the turn's trace_id. _record_proxy_spend rebinds it so a
    STREAMED call's deferred ledger write (which runs from the relay teardown, AFTER the
    route's log scope has exited) still joins the turn's trace end-to-end."""
    from agentcore.core.log_context import get_log_value

    seen: dict = {}

    class _FakeCostRepo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **_kw):
            # Read what's bound at the moment the ledger row is written.
            seen["trace_id"] = get_log_value("trace_id")
            seen["conversation_id"] = get_log_value("conversation_id")
            return 1

    monkeypatch.setattr(inference, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(inference, "CostEventRepository", _FakeCostRepo)

    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=inference._usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
        trace_id="trace-xyz",
    )
    assert seen == {"trace_id": "trace-xyz", "conversation_id": "c1"}


async def test_forward_unary_threads_trace_id(monkeypatch):
    """The unary path forwards the turn's trace_id to the spend recorder."""
    spend: list = []
    monkeypatch.setattr(inference, "_record_proxy_spend", lambda **kw: spend.append(kw))

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"model": "m", "usage": {"prompt_tokens": 1, "completion_tokens": 1}},
        )

    client = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(_handler)
    )
    await inference._forward_unary(
        client, {"model": "m"}, user_id="u1", conversation_id="c1", trace_id="t-abc"
    )
    assert spend[0]["trace_id"] == "t-abc"


async def test_forward_stream_threads_trace_id(monkeypatch):
    """The streamed path forwards the turn's trace_id to the deferred spend recorder."""
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        async def _body():
            yield (
                b'data: {"choices":[{"delta":{}}],'
                b'"usage":{"prompt_tokens":1,"completion_tokens":1},"model":"m"}\n\n'
            )
            yield b"data: [DONE]\n\n"

        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=_body()
        )

    client = httpx.AsyncClient(
        base_url="http://upstream", transport=httpx.MockTransport(_handler)
    )
    resp = await inference._forward_stream(
        client,
        {"model": "m", "stream": True},
        user_id="u1",
        conversation_id="c1",
        trace_id="t-stream",
    )
    async for _chunk in resp.body_iterator:
        pass

    assert spend[0]["trace_id"] == "t-stream"
