"""Wire dialect resolution — Kimi/Moonshot omit_temperature + Anthropic regression."""

from __future__ import annotations

import pytest

from agentcore.llm.provider.openai_compatible import OpenAICompatibleProvider
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest
from agentcore.llm.provider.wire_dialect import resolve_wire_dialect

_MOONSHOT_URL = "https://api.moonshot.cn/v1"
_MOONSHOT_AI_URL = "https://api.moonshot.ai/v1"
_ZEN_URL = "https://opencode.ai/zen/v1"
_GO_URL = "https://opencode.ai/zen/go/v1"


@pytest.mark.parametrize(
    "model",
    ["kimi-k3", "kimi-k2.5", "kimi-k2.6", "platform/kimi-k2.6"],
)
def test_resolve_omits_temperature_for_kimi_leaf(model: str):
    assert resolve_wire_dialect(model).omit_temperature is True
    assert resolve_wire_dialect(model, base_url=_ZEN_URL).omit_temperature is True
    assert resolve_wire_dialect(model, base_url=_GO_URL).omit_temperature is True


def test_resolve_keeps_temperature_for_moonshot_v1_leaf():
    assert resolve_wire_dialect("moonshot-v1-128k").omit_temperature is False
    assert (
        resolve_wire_dialect("moonshot-v1-128k", base_url=_MOONSHOT_URL).omit_temperature
        is False
    )


def test_resolve_short_k3_omits_only_on_moonshot_base_url():
    assert resolve_wire_dialect("k3").omit_temperature is False
    assert resolve_wire_dialect("k3", base_url=_ZEN_URL).omit_temperature is False
    assert resolve_wire_dialect("k3", base_url=_GO_URL).omit_temperature is False
    assert resolve_wire_dialect("k3", base_url=_MOONSHOT_URL).omit_temperature is True
    assert resolve_wire_dialect("k3", base_url=_MOONSHOT_AI_URL).omit_temperature is True


@pytest.mark.parametrize(
    "model",
    [
        "platform/claude-opus-5",
        "claude-opus-4-7",
        "claude-opus-4.8",
        "anthropic/claude-fable-5",
        "claude-mythos-5",
    ],
)
def test_resolve_anthropic_restricted_leaves_still_omit(model: str):
    assert resolve_wire_dialect(model).omit_temperature is True


def test_resolve_ordinary_models_keep_temperature():
    for model in ("gpt-4o", "deepseek-v4-flash", "claude-opus-4-20250514", "hy3"):
        assert resolve_wire_dialect(model).omit_temperature is False, model
        assert resolve_wire_dialect(model, base_url=_ZEN_URL).omit_temperature is False, model
        assert resolve_wire_dialect(model, base_url=_GO_URL).omit_temperature is False, model


@pytest.mark.parametrize("model", ["kimi-k3", "kimi-k2.5", "kimi-k2.6"])
def test_build_payload_omits_temperature_for_kimi(model: str):
    provider = OpenAICompatibleProvider(name="test", api_key="k", base_url=_ZEN_URL)
    req = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model=model,
        temperature=0.7,
    )
    payload = provider._build_payload(req, stream=False)
    assert "temperature" not in payload


def test_build_payload_keeps_temperature_for_moonshot_v1():
    provider = OpenAICompatibleProvider(name="test", api_key="k", base_url=_MOONSHOT_URL)
    req = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="moonshot-v1-128k",
        temperature=0.7,
    )
    payload = provider._build_payload(req, stream=False)
    assert payload["temperature"] == 0.7


def test_build_payload_short_k3_omits_on_moonshot_base_url():
    moonshot = OpenAICompatibleProvider(name="test", api_key="k", base_url=_MOONSHOT_URL)
    zen = OpenAICompatibleProvider(name="test", api_key="k", base_url=_ZEN_URL)
    go = OpenAICompatibleProvider(name="test", api_key="k", base_url=_GO_URL)
    req = LLMRequest(
        messages=[LLMMessage(role="user", content="hi")],
        model="k3",
        temperature=0.5,
    )
    assert "temperature" not in moonshot._build_payload(req, stream=False)
    assert zen._build_payload(req, stream=False)["temperature"] == 0.5
    assert go._build_payload(req, stream=False)["temperature"] == 0.5
