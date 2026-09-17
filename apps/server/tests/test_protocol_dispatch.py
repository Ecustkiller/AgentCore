"""Per-model chat/completions vs /messages dispatch (no live upstream)."""

from __future__ import annotations

import json

import httpx

from agentcore.llm.provider.anthropic import AnthropicMessagesProvider
from agentcore.llm.provider.anthropic_messages import (
    ANTHROPIC_VERSION,
    DEFAULT_MAX_TOKENS,
)
from agentcore.llm.provider.dispatch import ProtocolDispatchProvider, build_credential_leaf
from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest, LLMResponse

_ZEN = "https://opencode.ai/zen/v1"
_RELAY = "https://openrouter.ai/api/v1"


def _request(model: str) -> LLMRequest:
    return LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=model,
        stream=False,
    )


async def test_dispatch_routes_complete_by_model(monkeypatch):
    seen: list[str] = []

    async def _openai_complete(self, request: LLMRequest) -> LLMResponse:
        seen.append(f"openai:{request.model}")
        return LLMResponse(content="flash", model=request.model)

    async def _anthropic_complete(self, request: LLMRequest) -> LLMResponse:
        seen.append(f"anthropic:{request.model}")
        return LLMResponse(content="haiku", model=request.model)

    monkeypatch.setattr(OpenAICompatibleProvider, "complete", _openai_complete)
    monkeypatch.setattr(AnthropicMessagesProvider, "complete", _anthropic_complete)
    leaf = build_credential_leaf(name="user", api_key="sk-test", base_url=_ZEN)
    try:
        assert isinstance(leaf, ProtocolDispatchProvider)
        assert isinstance(leaf._leaf("deepseek-v4-flash"), OpenAICompatibleProvider)
        assert isinstance(leaf._leaf("claude-haiku-4-5"), AnthropicMessagesProvider)
        flash = await leaf.complete(_request("deepseek-v4-flash"))
        haiku = await leaf.complete(_request("claude-haiku-4-5"))
        union = await leaf.complete(_request("union-alpha"))
        assert flash.content == "flash"
        assert haiku.content == "haiku"
        assert union.content == "haiku"
        assert seen == [
            "openai:deepseek-v4-flash",
            "anthropic:claude-haiku-4-5",
            "anthropic:union-alpha",
        ]
    finally:
        await leaf.close()

    relay = build_credential_leaf(name="user", api_key="sk-test", base_url=_RELAY)
    try:
        assert isinstance(relay._leaf("claude-haiku-4-5"), OpenAICompatibleProvider)
        out = await relay.complete(_request("claude-haiku-4-5"))
        assert out.content == "flash"
        assert seen[-1] == "openai:claude-haiku-4-5"
    finally:
        await relay.close()


async def test_anthropic_complete_posts_messages_path():
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["headers"] = {k.lower(): v for k, v in request.headers.items()}
        captured["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "id": "msg_1",
                "model": "claude-haiku-4-5",
                "role": "assistant",
                "content": [{"type": "text", "text": "pong"}],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 1},
            },
        )

    provider = AnthropicMessagesProvider(
        name="user", api_key="sk-test", base_url=_ZEN
    )
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=_ZEN, transport=httpx.MockTransport(handler)
    )
    try:
        response = await provider.complete(_request("claude-haiku-4-5"))
        assert response.content == "pong"
        assert captured["path"] == "/zen/v1/messages"
        assert captured["body"]["model"] == "claude-haiku-4-5"
        assert captured["body"]["messages"] == [{"role": "user", "content": "hi"}]
        assert captured["headers"].get("anthropic-version") == ANTHROPIC_VERSION
        assert captured["body"]["max_tokens"] == DEFAULT_MAX_TOKENS
        assert captured["body"]["stream"] is False
        assert captured["body"]["temperature"] == 0.7
        assert "thinking" not in captured["body"]
    finally:
        await provider.close()


def test_inference_hop_forwards_thinking_blocks_vendor_does_not():
    from agentcore.llm.provider.protocol import ToolCall, ToolCallFunction

    blocks = [
        {"type": "thinking", "thinking": "plan", "signature": "sig_hop"}
    ]
    messages = [
        LLMMessage(role="user", content="hi"),
        LLMMessage(
            role="assistant",
            content="",
            reasoning_content="plan",
            thinking_blocks=blocks,
            tool_calls=[
                ToolCall(
                    id="t1",
                    function=ToolCallFunction(name="read_file", arguments="{}"),
                )
            ],
        ),
    ]
    hop = OpenAICompatibleProvider(
        name="user",
        api_key="sk-test",
        base_url="http://127.0.0.1:9/v1/inference/v1",
    )
    vendor = OpenAICompatibleProvider(
        name="user", api_key="sk-test", base_url=_ZEN
    )
    req = LLMRequest(messages=messages, model="claude-haiku-4-5")
    hop_asst = hop._build_payload(req, stream=False)["messages"][1]
    vendor_asst = vendor._build_payload(req, stream=False)["messages"][1]
    assert hop_asst["reasoning_content"] == "plan"
    assert hop_asst["thinking_blocks"] == blocks
    assert "thinking_blocks" not in vendor_asst
    assert "reasoning_content" not in vendor_asst
