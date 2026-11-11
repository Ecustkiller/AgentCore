"""Shared-prefill warm gate + explicit Anthropic cache breakpoints.

Both features are opt-in (default off); these tests pin the byte-identical
default wire and the bounded, fail-open enabled behaviour.
"""

from __future__ import annotations

import asyncio
import json

import httpx

from agentcore.config import settings
from agentcore.llm.provider import anthropic as anthropic_leaf
from agentcore.llm.provider.anthropic import AnthropicMessagesProvider
from agentcore.llm.provider.anthropic_messages import (
    build_messages_payload,
    strip_prompt_cache_breakpoints,
)
from agentcore.llm.provider.protocol import LLMMessage, LLMRequest
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.prefix_warm import (
    PrefixWarmGate,
    bind_prefix_warm_gate,
    current_prefix_warm_gate,
    mark_shared_prefix_warmed,
    reset_prefix_warm_gate,
    wait_for_shared_prefix,
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


# ---------------------------------------------------------------------------
# Default wire is untouched
# ---------------------------------------------------------------------------


def test_default_payload_has_no_cache_control():
    payload = build_messages_payload(_request(), stream=True)
    assert isinstance(payload["system"], str)
    assert "cache_control" not in json.dumps(payload)


def test_default_warm_window_is_off():
    assert warm_window_seconds() == 0.0
    assert current_prefix_warm_gate() is None


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


async def test_wave_default_does_not_bind_gate(monkeypatch):
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.0)
    seen: list[object] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        seen.append(current_prefix_warm_gate())
        return RunState(phase=RunPhase.COMPLETED)

    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(RunSpec(run_id=x, task="t", agent_id=x, role=x))
    await WaveScheduler(max_parallel=3).run(plan, ex)
    assert seen == [None, None, None]


async def test_wave_enabled_shares_one_gate_and_only_one_leader(monkeypatch):
    monkeypatch.setattr(settings, "engine_prefix_warm_window_seconds", 0.05)
    seen: list[object] = []
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

    provider = AnthropicMessagesProvider(name="user", api_key="sk-test", base_url=_ZEN)
    await provider._client.aclose()
    provider._client = httpx.AsyncClient(
        base_url=_ZEN, transport=httpx.MockTransport(handler)
    )
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
