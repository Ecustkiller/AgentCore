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

import json
from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from agentcore.api.routes import inference
from agentcore.core.errors import (
    AuthenticationError,
    BYOKKeyMissingError,
    LLMUpstreamError,
    QuotaExceededError,
)
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import (
    LLMMessage,
    LLMRequest,
    ToolCall,
    ToolCallFunction,
)
from agentcore.security import create_access_token, create_inference_token

pytestmark = pytest.mark.anyio


# --- token mint / verify -----------------------------------------------------


async def test_mint_inference_token_includes_resolved_model(monkeypatch):
    async def _fake_resolve(_session, user_id):
        assert user_id == "u1"
        return "deepseek-v4-flash"

    monkeypatch.setattr(
        inference.token,
        "resolve_user_chat_model",
        _fake_resolve,
    )
    async def _noop_rate_limit(_user_id):
        return None

    monkeypatch.setattr(
        inference.token,
        "enforce_inference_token_mint_rate_limit",
        _noop_rate_limit,
    )
    user = SimpleNamespace(user_id="u1")
    resp = await inference.token.mint_inference_token(user, session=None)
    assert resp.model == "deepseek-v4-flash"
    assert resp.expires_in_sec > 0
    assert resp.token


def test_inference_token_roundtrip():
    token = create_inference_token("user-1")
    assert inference.decode_inference_token(token) == "user-1"


def test_inference_token_rejects_access_token():
    """An access token must NOT authorize the inference proxy (wrong type)."""
    access = create_access_token("user-1", audience="product")
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
            authorization=f"Bearer {create_access_token('u1', audience='product')}",
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
    async def _fake_preflight(**_kwargs):
        return LLMCredentials(
            api_key="sk-user",
            base_url="https://api.deepseek.com",
            default_model="deepseek-v4-flash",
        )

    monkeypatch.setattr(inference.proxy, "preflight_llm_credentials", _fake_preflight)
    cfg = await inference._resolve_inference_credentials(
        None, None, SimpleNamespace(user_id="u1", billing_preference="byok")
    )
    assert cfg.api_key == "sk-user"
    assert cfg.source == "byok"


async def test_resolve_credentials_byok_missing_key_refuses(monkeypatch):
    async def _fake_preflight(**_kwargs):
        raise BYOKKeyMissingError("missing key")

    monkeypatch.setattr(inference.proxy, "preflight_llm_credentials", _fake_preflight)
    with pytest.raises(BYOKKeyMissingError):
        await inference._resolve_inference_credentials(
            None, None, SimpleNamespace(user_id="u1", billing_preference="byok")
        )


async def test_resolve_credentials_platform_enforces_quota_then_uses_global(monkeypatch):
    monkeypatch.setattr(inference.settings, "platform_api_key", "sk-platform")
    monkeypatch.setattr(inference.settings, "platform_base_url", "https://api.deepseek.com/v1")
    monkeypatch.setattr(inference.settings, "platform_model", "deepseek-v4-flash")
    seen: dict = {}

    async def _fake_preflight(*, session, user, cost_repo, byok_missing_message):
        seen["user_id"] = user.user_id
        seen["cost_repo"] = cost_repo
        return None

    monkeypatch.setattr(inference.proxy, "preflight_llm_credentials", _fake_preflight)
    cfg = await inference._resolve_inference_credentials(
        None, "COST_REPO", SimpleNamespace(user_id="u1", billing_preference="platform")
    )
    assert cfg.api_key == "sk-platform"
    assert cfg.source == "platform"
    assert seen == {"user_id": "u1", "cost_repo": "COST_REPO"}


async def test_resolve_credentials_platform_quota_exceeded_propagates(monkeypatch):
    async def _fake_preflight(**_kwargs):
        raise QuotaExceededError("over budget")

    monkeypatch.setattr(inference.proxy, "preflight_llm_credentials", _fake_preflight)
    with pytest.raises(QuotaExceededError):
        await inference._resolve_inference_credentials(
            None, None, SimpleNamespace(user_id="u1", billing_preference="platform")
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
    usage = inference.usage_from_deepseek(
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


async def test_record_proxy_spend_carries_message_id_for_sidecar_turns(monkeypatch):
    calls = _capture_record_runs(monkeypatch)
    usage = inference.usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1})
    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=usage,
        message_id="msg-sidecar-1",
    )
    assert len(calls) == 1
    assert calls[0]["message_id"] == "msg-sidecar-1"


async def test_record_proxy_spend_skips_without_conversation(monkeypatch):
    calls = _capture_record_runs(monkeypatch)
    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id=None,
        model="deepseek-v4-flash",
        usage=inference.usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
    )
    assert calls == []  # no conversation → no row (can't satisfy the NOT NULL column)


async def test_record_proxy_spend_swallows_ledger_failure(monkeypatch):
    _capture_record_runs(monkeypatch, raises=True)
    # Must not raise — a ledger failure can't break a turn whose answer already streamed.
    await inference._record_proxy_spend(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=inference.usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
    )


def test_usage_from_deepseek_maps_fields():
    usage = inference.usage_from_deepseek(
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


def _provider(handler) -> OpenAICompatibleProvider:
    provider = OpenAICompatibleProvider(
        name="test", api_key="k", base_url="http://upstream/v1"
    )
    provider._client = httpx.AsyncClient(
        base_url="http://upstream/v1", transport=httpx.MockTransport(handler)
    )
    return provider


def _request(model: str = "deepseek-v4-flash", *, stream: bool = False) -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=model,
        stream=stream,
    )


async def test_llm_request_from_payload_uses_server_resolved_model():
    from agentcore.llm.resolve import ModelConfig

    req = inference.proxy._llm_request_from_payload(
        {
            "model": "gpt-5.5",
            "messages": [{"role": "user", "content": "hi"}],
        },
        ModelConfig(
            model="deepseek-v4-flash",
            base_url="https://api.deepseek.com",
            api_key="sk",
            source="byok",
            purpose="chat",
        ),
    )
    assert req.model == "deepseek-v4-flash"


async def test_forward_unary_passes_through_and_records(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        return httpx.Response(
            200,
            json={
                "model": "deepseek-v4-flash",
                "choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            },
        )

    provider = _provider(_handler)
    resp = await inference._forward_unary(
        provider, _request(), user_id="u1", conversation_id="c1"
    )

    assert resp.status_code == 200
    assert b'"content": "hi"' in resp.body
    assert len(spend) == 1
    assert spend[0]["conversation_id"] == "c1"
    assert spend[0]["model"] == "deepseek-v4-flash"
    assert spend[0]["usage"].output_tokens == 5


async def test_forward_unary_passes_error_status_through(monkeypatch):
    spend: list = []
    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(402, json={"error": "insufficient balance"})

    provider = _provider(_handler)
    resp = await inference._forward_unary(
        provider, _request(), user_id="u1", conversation_id="c1"
    )

    assert resp.status_code == 502
    body = resp.body.decode()
    assert "余额" in body or "LLM_INSUFFICIENT_BALANCE" in body


async def test_forward_stream_relays_and_records(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        async def _body():
            yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
            yield (
                b'data: {"choices":[{"delta":{}}],'
                b'"usage":{"prompt_tokens":10,"completion_tokens":5},'
                b'"model":"deepseek-v4-flash"}\n\n'
            )
            yield b"data: [DONE]\n\n"

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_body())

    provider = _provider(_handler)
    resp = await inference._forward_stream(
        provider, _request(stream=True), user_id="u1", conversation_id="c1"
    )

    collected = ""
    async for chunk in resp.body_iterator:
        collected += chunk

    # The content delta + DONE sentinel are relayed verbatim to the sidecar.
    assert '"content": "hi"' in collected or '"content":"hi"' in collected
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
        usage=inference.usage_from_deepseek({"prompt_tokens": 10, "completion_tokens": 1}),
        trace_id="trace-xyz",
    )
    assert seen == {"trace_id": "trace-xyz", "conversation_id": "c1"}


async def test_forward_unary_threads_trace_id(monkeypatch):
    """The unary path forwards the turn's trace_id to the spend recorder."""
    spend: list = []
    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "m",
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    provider = _provider(_handler)
    await inference._forward_unary(
        provider, _request("m"), user_id="u1", conversation_id="c1", trace_id="t-abc"
    )
    assert spend and spend[0]["trace_id"] == "t-abc"


async def test_forward_stream_upstream_error_returns_502(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    class _FailingProvider:
        async def stream(self, _request):
            from agentcore.core.errors import LLMUpstreamError

            raise LLMUpstreamError(
                "platform 服务端错误（503），请稍后再试",
                upstream_status=503,
            )
            yield  # pragma: no cover — makes this an async generator

        async def close(self):
            pass

    resp = await inference._forward_stream(
        _FailingProvider(),
        _request(stream=True),
        user_id="u1",
        conversation_id="c1",
    )

    assert resp.status_code == 502
    assert resp.headers.get("x-upstream-retried") == "3"
    body = resp.body.decode()
    assert "error" in body
    assert spend == []


async def test_forward_stream_client_error_surfaces_upstream_message(monkeypatch):
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    class _FailingProvider:
        async def stream(self, _request):
            from agentcore.core.errors import LLMError

            raise LLMError(
                "user The `reasoning_content` in the thinking mode must be passed back.",
                upstream_status=400,
                upstream_body_preview='{"error":{"message":"reasoning_content required"}}',
            )
            yield  # pragma: no cover

        async def close(self):
            pass

    resp = await inference._forward_stream(
        _FailingProvider(),
        _request(stream=True),
        user_id="u1",
        conversation_id="c1",
    )

    assert resp.status_code == 502
    body = resp.body.decode()
    assert "reasoning_content" in body
    assert "上游推理服务不可达" not in body
    assert spend == []


async def test_provider_skips_retry_when_proxy_already_retried():
    attempts: list[int] = []

    def _handler(_request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        return httpx.Response(
            502,
            headers={"X-Upstream-Retried": "3"},
            json={"error": {"message": "upstream failed"}},
        )

    provider = _provider(_handler)
    with pytest.raises(LLMUpstreamError):
        async for _line in provider.stream(_request(stream=True)):
            pass

    assert len(attempts) == 1


async def test_forward_stream_threads_trace_id(monkeypatch):
    """The streamed path forwards the turn's trace_id to the deferred spend recorder."""
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        async def _body():
            yield (
                b'data: {"choices":[{"delta":{}}],'
                b'"usage":{"prompt_tokens":1,"completion_tokens":1},"model":"m"}\n\n'
            )
            yield b"data: [DONE]\n\n"

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_body())

    provider = _provider(_handler)
    resp = await inference._forward_stream(
        provider,
        _request("m", stream=True),
        user_id="u1",
        conversation_id="c1",
        trace_id="t-stream",
    )
    async for _chunk in resp.body_iterator:
        pass

    assert spend and spend[0]["trace_id"] == "t-stream"


# --- tool-loop fidelity (保真: proxy must forward the full tool shape both ways) ----
#
# The proxy hand-rolls dict↔domain mapping on BOTH boundaries (inbound request rebuild
# + outbound SSE/JSON re-serialization), parallel to the provider's own _build_payload /
# stream parsing. That duplication silently dropped tool_calls / tool_call_id /
# reasoning_content, so ANY proxied multi-turn tool call broke: DeepSeek's thinking-mode
# tool contract 400s when the echoed assistant/tool shape is incomplete, and a streamed
# round-1 tool call never even reached the sidecar. These tests pin BOTH directions.


def _cfg():
    from agentcore.llm.resolve import ModelConfig

    return ModelConfig(
        model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
        api_key="sk",
        source="byok",
        purpose="chat",
    )


def test_llm_request_from_payload_preserves_tool_call_messages():
    """(a) Request parse fidelity: a round-2 window rebuilds the FULL assistant/tool
    field set — tool_calls (as ToolCall/ToolCallFunction), tool_call_id,
    reasoning_content — not just role+content."""
    payload = {
        "model": "gpt-5.5",
        "messages": [
            {"role": "user", "content": "search AgentCore"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "I should search first.",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "web_search", "arguments": '{"q": "AgentCore"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "top hits ..."},
        ],
    }
    req = inference.proxy._llm_request_from_payload(payload, _cfg())

    assistant = req.messages[1]
    assert assistant.role == "assistant"
    assert assistant.reasoning_content == "I should search first."
    assert assistant.tool_calls is not None and len(assistant.tool_calls) == 1
    assert assistant.tool_calls[0].id == "call_1"
    assert assistant.tool_calls[0].function.name == "web_search"
    assert assistant.tool_calls[0].function.arguments == '{"q": "AgentCore"}'

    tool_msg = req.messages[2]
    assert tool_msg.role == "tool"
    assert tool_msg.tool_call_id == "call_1"
    assert tool_msg.content == "top hits ..."


def test_llm_request_from_payload_is_build_payload_inverse():
    """Ratchet: the proxy's request parse is the faithful INVERSE of the provider's
    _build_payload. Round-tripping a tool-loop window through build∘parse∘build must be
    byte-stable (== build), so any future field silently dropped on the inbound rebuild
    (the original P0) re-breaks this test instead of shipping."""
    provider = OpenAICompatibleProvider(name="t", api_key="k", base_url="http://x/v1")
    original = LLMRequest(
        messages=[
            LLMMessage(role="system", content="be brief"),
            LLMMessage(role="user", content="use a tool"),
            LLMMessage(
                role="assistant",
                content="",
                reasoning_content="thinking about it",
                tool_calls=[
                    ToolCall(
                        id="call_1",
                        function=ToolCallFunction(name="web_search", arguments='{"q":"x"}'),
                    )
                ],
            ),
            LLMMessage(role="tool", content="tool output", tool_call_id="call_1"),
            # An assistant tool-call turn whose model omitted reasoning: _build_payload
            # emits reasoning_content="" (DeepSeek echo rule); parse must keep it stable.
            LLMMessage(
                role="assistant",
                content=None,
                tool_calls=[
                    ToolCall(
                        id="call_2",
                        function=ToolCallFunction(name="finish", arguments="{}"),
                    )
                ],
            ),
            LLMMessage(role="tool", content="ok", tool_call_id="call_2"),
        ],
        model="deepseek-v4-flash",
    )

    wire1 = provider._build_payload(original, stream=False)
    parsed = inference.proxy._llm_request_from_payload(wire1, _cfg())
    wire2 = provider._build_payload(parsed, stream=False)

    assert wire1["messages"] == wire2["messages"]


async def test_forward_unary_round2_delivers_full_tool_shape_upstream(monkeypatch):
    """(a) End-to-end request fidelity: a round-2 window parsed by the proxy must reach
    the upstream (DeepSeek) with the complete tool shape — the exact bytes the
    thinking-mode tool contract requires, so the call no longer 400s."""

    async def _fake_spend(**_kw):
        pass

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)
    captured: dict = {}

    def _handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "deepseek-v4-flash",
                "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            },
        )

    payload = {
        "model": "gpt-5.5",
        "messages": [
            {"role": "user", "content": "search"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "thinking",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "web_search", "arguments": '{"q":"x"}'},
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "hits"},
        ],
    }
    req = inference.proxy._llm_request_from_payload(payload, _cfg())
    provider = _provider(_handler)
    await inference._forward_unary(provider, req, user_id="u1", conversation_id="c1")

    sent = captured["body"]["messages"]
    assistant = sent[1]
    assert assistant["tool_calls"][0]["id"] == "call_1"
    assert assistant["tool_calls"][0]["function"]["name"] == "web_search"
    assert assistant["tool_calls"][0]["function"]["arguments"] == '{"q":"x"}'
    assert assistant["reasoning_content"] == "thinking"
    tool_msg = sent[2]
    assert tool_msg["role"] == "tool"
    assert tool_msg["tool_call_id"] == "call_1"
    assert tool_msg["content"] == "hits"


async def test_forward_stream_relays_tool_call_deltas(monkeypatch):
    """(b) Streaming relay fidelity: DeepSeek streams a tool call as OpenAI
    delta.tool_calls[] fragments; the proxy must relay them (index/id/function.name/
    arguments) so the sidecar's stream parser reconstructs the call. Pre-fix the proxy
    dropped them, so a proxied tool call never surfaced and delegate/debate couldn't
    start. Proven by re-parsing the proxy's own relayed bytes with the sidecar's
    provider and accumulating the deltas exactly like the engine does."""
    spend: list = []

    async def _fake_spend(**kw):
        spend.append(kw)

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        async def _body():
            # First fragment: id + function name + partial arguments.
            yield (
                b'data: {"choices":[{"index":0,"delta":{"tool_calls":['
                b'{"index":0,"id":"call_1","type":"function",'
                b'"function":{"name":"web_search","arguments":"{\\"q\\":"}}]}}]}\n\n'
            )
            # Continuation fragment: only the trailing arguments (no id/name).
            yield (
                b'data: {"choices":[{"index":0,"delta":{"tool_calls":['
                b'{"index":0,"function":{"arguments":"\\"AgentCore\\"}"}}]}}]}\n\n'
            )
            yield (
                b'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],'
                b'"usage":{"prompt_tokens":10,"completion_tokens":5},'
                b'"model":"deepseek-v4-flash"}\n\n'
            )
            yield b"data: [DONE]\n\n"

        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=_body())

    provider = _provider(_handler)
    resp = await inference._forward_stream(
        provider, _request(stream=True), user_id="u1", conversation_id="c1"
    )
    collected = ""
    async for chunk in resp.body_iterator:
        collected += chunk

    # Re-parse the proxy's relayed SSE with the SAME provider the sidecar runs and
    # accumulate the tool-call deltas exactly like stream_llm_round → the relayed bytes
    # must reconstruct the original call end-to-end.
    replay = _provider(
        lambda _r: httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=collected.encode(),
        )
    )
    acc = {"id": "", "name": "", "arguments": ""}
    async for chunk in replay.stream(_request(stream=True)):
        for tc in chunk.delta_tool_calls or []:
            if tc.id:
                acc["id"] = tc.id
            if tc.function_name:
                acc["name"] = tc.function_name
            if tc.arguments_delta:
                acc["arguments"] += tc.arguments_delta

    assert acc == {"id": "call_1", "name": "web_search", "arguments": '{"q":"AgentCore"}'}
    assert len(spend) == 1
    assert spend[0]["usage"].output_tokens == 5


async def test_forward_unary_includes_reasoning_content(monkeypatch):
    """A unary tool-call response carries BOTH tool_calls and reasoning_content, so a
    client echoing the turn on the next round satisfies DeepSeek's thinking-mode rule."""

    async def _fake_spend(**_kw):
        pass

    monkeypatch.setattr(inference.proxy, "_record_proxy_spend", _fake_spend)

    def _handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "model": "deepseek-v4-flash",
                "choices": [
                    {
                        "message": {
                            "content": "",
                            "reasoning_content": "let me search",
                            "tool_calls": [
                                {
                                    "id": "call_9",
                                    "type": "function",
                                    "function": {"name": "web_search", "arguments": "{}"},
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            },
        )

    provider = _provider(_handler)
    resp = await inference._forward_unary(
        provider, _request(), user_id="u1", conversation_id="c1"
    )
    message = json.loads(resp.body)["choices"][0]["message"]
    assert message["reasoning_content"] == "let me search"
    assert message["tool_calls"][0]["id"] == "call_9"
    assert message["tool_calls"][0]["function"]["name"] == "web_search"
