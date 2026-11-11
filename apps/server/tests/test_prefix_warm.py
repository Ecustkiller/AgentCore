"""Shared-prefill warm gate + explicit Anthropic cache breakpoints.

Provider-aware defaults turn the Anthropic-Messages wire on; explicit settings
still override every path, and the 400 strip fallback stays byte-identical.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import cast

import httpx

from agentcore.config import settings
from agentcore.config.engine import DEFAULT_ANTHROPIC_MESSAGES_WARM_WINDOW_SECONDS
from agentcore.llm.provider import anthropic as anthropic_leaf
from agentcore.llm.provider.anthropic import AnthropicMessagesProvider
from agentcore.llm.provider.anthropic_messages import (
    build_messages_payload,
    strip_prompt_cache_breakpoints,
)
from agentcore.llm.provider.protocol import LLMMessage, LLMProvider, LLMRequest
from agentcore.llm.provider.router import ProviderRouter
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.prefix_warm import (
    PrefixWarmGate,
    bind_prefix_warm_gate,
    current_prefix_warm_gate,
    mark_shared_prefix_warmed,
    request_uses_anthropic_messages,
    reset_prefix_warm_gate,
    wait_for_shared_prefix,
    warm_gate_policy,
    warm_window_seconds,
)
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler

_ZEN = "https://opencode.ai/zen/v1"


def _request(*, system: str = "constitution", tools: bool = True) -> LLMRequest:
    messages = [LLMMessage(role="system", content=system)] if system else []
    messages.append(LLMMessage(role="user", content="do the task"))
    return LLMRequest(
        messages=messages,
        model="claude-haiku-4-5",
        tools=[
            {
                "type": "function",
                "function": {"name": "read_file", "description": "", "parameters": {}},
            },
            {
                "type": "function",
                "function": {"name": "write_file", "description": "", "parameters": {}},
            },
        ]
        if tools
        else None,
    )


def _anthropic_response() -> dict:
    return {
        "id": "msg_1",
        "model": "claude-haiku-4-5",
        "role": "assistant",
        "content": [{"type": "text", "text": "pong"}],
        "stop_reason": "end_turn",
        "usage": {"input_tokens": 3, "output_tokens": 1},
    }


async def _provider_with_handler(handler) -> AnthropicMessagesProvider:
    provider = AnthropicMessagesProvider(name="user", api_key="sk-test", base_url=_ZEN)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=_ZEN, transport=httpx.MockTransport(handler)
    )
    return provider


# ---------------------------------------------------------------------------
# Dialect-aware defaults + explicit overrides
# ---------------------------------------------------------------------------


def test_default_payload_builder_stays_plain():
    payload = build_messages_payload(_request(), stream=True)
    assert isinstance(payload["system"], str)
    assert "cache_control" not in json.dumps(payload)


def test_engine_resolvers_preserve_explicit_overrides(monkeypatch):
    assert settings.resolve_prompt_cache_breakpoints(anthropic_messages=True) is True
    assert settings.resolve_prompt_cache_breakpoints(anthropic_messages=False) is False
    assert settings.resolve_prefix_cache_observability(anthropic_messages=True) is True
    assert settings.resolve_prefix_cache_observability(anthropic_messages=False) is False
    assert (
        settings.resolve_prefix_warm_window_seconds(anthropic_messages=True)
        == DEFAULT_ANTHROPIC_MESSAGES_WARM_WINDOW_SECONDS
    )
    assert settings.resolve_prefix_warm_window_seconds(anthropic_messages=False) == 0.0

    monkeypatch.setattr(settings, "engine_prompt_cache_breakpoints", False)
    monkeypatch.setattr(settings, "engine_prefix_cache_observability", True)
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.25)
    assert settings.resolve_prompt_cache_breakpoints(anthropic_messages=True) is False
    assert settings.resolve_prefix_cache_observability(anthropic_messages=False) is True
    assert settings.resolve_prefix_warm_window_seconds(anthropic_messages=False) == 0.25


def test_default_warm_window_is_anthropic_scoped():
    assert warm_window_seconds() == DEFAULT_ANTHROPIC_MESSAGES_WARM_WINDOW_SECONDS
    policy = warm_gate_policy()
    assert policy.window == DEFAULT_ANTHROPIC_MESSAGES_WARM_WINDOW_SECONDS
    assert policy.anthropic_only is True
    assert current_prefix_warm_gate() is None


def test_explicit_warm_window_is_provider_agnostic(monkeypatch):
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.05)
    assert warm_window_seconds() == 0.05
    assert warm_gate_policy().anthropic_only is False


def test_prompt_cache_breakpoints_default_on_and_explicit_off(monkeypatch):
    anthropic_leaf._PROMPT_CACHE_REJECTED.discard(_ZEN)
    assert anthropic_leaf._prompt_cache_enabled(_ZEN) is True
    monkeypatch.setattr(settings, "engine_prompt_cache_breakpoints", False)
    assert anthropic_leaf._prompt_cache_enabled(_ZEN) is False


async def test_anthropic_leaf_default_wire_marks_breakpoints():
    anthropic_leaf._PROMPT_CACHE_REJECTED.discard(_ZEN)
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=_anthropic_response())

    provider = await _provider_with_handler(handler)
    try:
        response = await provider.complete(_request())
        assert response.content == "pong"
        assert len(bodies) == 1
        assert "cache_control" in json.dumps(bodies[0])
    finally:
        await provider.close()
        anthropic_leaf._PROMPT_CACHE_REJECTED.discard(_ZEN)


def test_request_uses_anthropic_messages_resolves_router_leaf():
    zen_leaf = cast(LLMProvider, SimpleNamespace(base_url=_ZEN))
    deepseek_leaf = cast(LLMProvider, SimpleNamespace(base_url="https://api.deepseek.com"))
    router = ProviderRouter(
        default=deepseek_leaf,
        providers={"opencode_zen": zen_leaf, "platform": zen_leaf},
    )
    assert (
        request_uses_anthropic_messages(router, "opencode_zen/claude-haiku-4-5") is True
    )
    assert request_uses_anthropic_messages(router, "platform/claude-sonnet-4-5") is True
    assert request_uses_anthropic_messages(router, "deepseek-v4.1-flash") is False
    assert request_uses_anthropic_messages(router, "unknown/claude-haiku-4-5") is False
    assert request_uses_anthropic_messages(SimpleNamespace(), "claude-haiku-4-5") is False


def test_enabled_payload_marks_system_and_last_tool_only():
    payload = build_messages_payload(_request(), stream=True, prompt_cache=True)
    assert payload["system"] == [
        {
            "type": "text",
            "text": "constitution",
            "cache_control": {"type": "ephemeral"},
        }
    ]
    assert payload["tools"][0].get("cache_control") is None
    assert payload["tools"][-1]["cache_control"] == {"type": "ephemeral"}
    assert payload["tool_choice"] == {"type": "auto"}


def test_enabled_payload_without_tools_or_system_stays_valid():
    no_system = build_messages_payload(
        _request(system="", tools=False), stream=True, prompt_cache=True
    )
    assert "system" not in no_system
    assert "tools" not in no_system


def test_strip_restores_byte_identical_payload():
    plain = build_messages_payload(_request(), stream=True)
    marked = build_messages_payload(_request(), stream=True, prompt_cache=True)
    assert strip_prompt_cache_breakpoints(marked) is True
    assert marked == plain
    assert strip_prompt_cache_breakpoints(marked) is False


# ---------------------------------------------------------------------------
# Gate primitives: one leader, bounded wait, no stranding
# ---------------------------------------------------------------------------


async def test_gate_single_leader_and_warm_release():
    gate = PrefixWarmGate(window=5.0)
    assert gate.claim_leader() is True
    assert gate.claim_leader() is False
    assert gate.warmed is False

    async def follower():
        await gate.wait_for_warm()
        return "released"

    task = asyncio.create_task(follower())
    await asyncio.sleep(0)
    assert not task.done()  # held until the leader lands its first chunk
    mark = asyncio.get_running_loop().time()
    gate.mark_warmed()
    assert await asyncio.wait_for(task, 1.0) == "released"
    assert asyncio.get_running_loop().time() - mark < 1.0
    assert gate.warmed is True


async def test_gate_follower_times_out_fail_open():
    gate = PrefixWarmGate(window=0.01)
    assert gate.claim_leader() is True  # leader exists but never marks warmed
    await asyncio.wait_for(gate.wait_for_warm(), 0.5)  # bounded, no hang


async def test_wait_for_shared_prefix_no_gate_is_noop():
    assert await wait_for_shared_prefix() is False


async def test_wait_for_shared_prefix_first_call_only(monkeypatch):
    gate = PrefixWarmGate(window=0.01)
    token = bind_prefix_warm_gate(gate)
    try:
        assert current_prefix_warm_gate() is gate
        assert await wait_for_shared_prefix() is True  # this task is leader
        assert await wait_for_shared_prefix() is False  # same gate, already consulted
    finally:
        reset_prefix_warm_gate(token)


async def test_dialect_scoped_gate_skips_non_anthropic_workers():
    gate = PrefixWarmGate(window=0.01, anthropic_only=True)
    token = bind_prefix_warm_gate(gate)
    try:
        assert await wait_for_shared_prefix(anthropic_messages=False) is False
        assert gate._claimed is False
        assert await wait_for_shared_prefix(anthropic_messages=True) is True
        assert gate._claimed is True
    finally:
        reset_prefix_warm_gate(token)


async def test_nested_fanout_gets_its_own_gate():
    outer = PrefixWarmGate(window=0.01)
    outer_token = bind_prefix_warm_gate(outer)
    try:
        assert await wait_for_shared_prefix() is True
        inner = PrefixWarmGate(window=0.01)
        inner_token = bind_prefix_warm_gate(inner)
        try:
            # Different gate identity ⇒ consulted again, not skipped.
            assert await wait_for_shared_prefix() is True
        finally:
            reset_prefix_warm_gate(inner_token)
    finally:
        reset_prefix_warm_gate(outer_token)


# ---------------------------------------------------------------------------
# WaveScheduler binds one gate per fan-out
# ---------------------------------------------------------------------------


async def test_explicit_zero_window_does_not_bind_gate(monkeypatch):
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.0)
    seen: list[PrefixWarmGate | None] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        seen.append(current_prefix_warm_gate())
        return RunState(phase=RunPhase.COMPLETED)

    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(RunSpec(run_id=x, task="t", agent_id=x, role=x))
    await WaveScheduler(max_parallel=3).run(plan, ex)
    assert seen == [None, None, None]


async def test_wave_default_gate_only_anthropic_worker_can_lead():
    seen: list[PrefixWarmGate | None] = []
    leaders: list[tuple[str, bool]] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        gate = current_prefix_warm_gate()
        seen.append(gate)
        is_anthropic = spec.run_id == "a"
        leader = await wait_for_shared_prefix(anthropic_messages=is_anthropic)
        leaders.append((spec.run_id, leader))
        if leader:
            mark_shared_prefix_warmed()
        return RunState(phase=RunPhase.COMPLETED)

    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(RunSpec(run_id=x, task="t", agent_id=x, role=x))
    result = await WaveScheduler(max_parallel=3).run(plan, ex)
    assert all(s.phase is RunPhase.COMPLETED for s in result.values())
    assert all(g is not None and g.anthropic_only for g in seen)
    assert [run_id for run_id, leader in leaders if leader] == ["a"]
    assert all(not leader for run_id, leader in leaders if run_id != "a")


async def test_wave_enabled_shares_one_gate_and_only_one_leader(monkeypatch):
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.05)
    seen: list[PrefixWarmGate | None] = []
    leaders: list[bool] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        seen.append(current_prefix_warm_gate())
        leaders.append(await wait_for_shared_prefix())
        if leaders[-1]:
            mark_shared_prefix_warmed()
        return RunState(phase=RunPhase.COMPLETED)

    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(RunSpec(run_id=x, task="t", agent_id=x, role=x))
    result = await WaveScheduler(max_parallel=3).run(plan, ex)
    assert all(s.phase is RunPhase.COMPLETED for s in result.values())
    assert all(g is not None for g in seen)
    assert all(not g.anthropic_only for g in seen if g is not None)
    assert seen[0] is seen[1] is seen[2]  # one gate for the whole fan-out
    assert sum(leaders) == 1  # exactly one warmer


# ---------------------------------------------------------------------------
# Explicit breakpoint: relay rejects cache_control ⇒ strip + retry once
# ---------------------------------------------------------------------------


async def test_anthropic_strips_cache_control_on_400_and_retries(monkeypatch):
    monkeypatch.setattr(settings, "engine_prompt_cache_breakpoints", True)
    anthropic_leaf._PROMPT_CACHE_REJECTED.discard(_ZEN)
    bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if len(bodies) == 1:
            return httpx.Response(
                400, json={"error": {"message": "unknown field cache_control"}}
            )
        return httpx.Response(200, json=_anthropic_response())

    provider = await _provider_with_handler(handler)
    try:
        response = await provider.complete(_request())
        assert response.content == "pong"
        assert len(bodies) == 2
        assert "cache_control" in json.dumps(bodies[0])
        assert "cache_control" not in json.dumps(bodies[1])
        assert isinstance(bodies[1]["system"], str)
        assert _ZEN in anthropic_leaf._PROMPT_CACHE_REJECTED
    finally:
        await provider.close()
        anthropic_leaf._PROMPT_CACHE_REJECTED.discard(_ZEN)
