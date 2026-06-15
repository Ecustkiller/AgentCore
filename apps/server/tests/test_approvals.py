"""Tests for the tool approval gate (CEO chat path).

Covers three layers:
  * ``ApprovalRegistry`` — the in-process bridge: unknown / double / wrong-
    conversation resolves are refused; a matching resolve settles the Future.
  * ``ApprovalGate`` — per-turn suspension: approve, timeout→deny, and
    "approve for the rest of the turn" skipping the second prompt; plus the
    required→resolved event pair.
  * ``react_loop`` integration — a GRANTABLE tool is gated (runs on approve,
    skipped with a denial tool-message on deny), while a non-GRANTABLE tool runs
    un-gated even when a gate is present.
"""

import asyncio
from pathlib import Path

import pytest

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.config import ModelProfile
from agentcore.llm.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.approvals import (
    ApprovalDecision,
    ApprovalGate,
    ApprovalRegistry,
)
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink, EventType, SSEEvent
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

pytestmark = pytest.mark.anyio


# --- helpers ---------------------------------------------------------------


def _drain(sink: EventSink) -> list[SSEEvent]:
    """Pop every event currently queued on the sink (test inspection)."""
    events: list[SSEEvent] = []
    while not sink._queue.empty():  # noqa: SLF001 - test-only inspection
        events.append(sink._queue.get_nowait())
    return events


async def _resolve_when_ready(
    registry: ApprovalRegistry,
    approval_id: str,
    decision: ApprovalDecision,
    conversation_id: str,
) -> None:
    """Resolve ``approval_id`` as soon as it appears pending (public API only).

    Retries via the public ``resolve`` (which is a no-op until the gate has
    registered the request), yielding the loop so the awaiting gate makes
    progress. Avoids reaching into registry internals to detect readiness.
    """
    for _ in range(2000):
        if registry.resolve(approval_id, decision, conversation_id=conversation_id):
            return
        await asyncio.sleep(0)
    raise AssertionError(f"approval {approval_id!r} never became pending")


def _gate(
    sink: EventSink,
    registry: ApprovalRegistry,
    *,
    conversation_id: str = "conv-1",
    timeout_seconds: float = 5.0,
) -> ApprovalGate:
    return ApprovalGate(
        sink=sink,
        conversation_id=conversation_id,
        registry=registry,
        timeout_seconds=timeout_seconds,
    )


# --- ApprovalRegistry ------------------------------------------------------


async def test_registry_resolve_unknown_returns_false():
    reg = ApprovalRegistry()
    assert reg.resolve("nope", ApprovalDecision.APPROVE, conversation_id="c") is False


async def test_registry_rejects_wrong_conversation():
    reg = ApprovalRegistry()
    fut = reg.create("a1", "conv-A")
    # A resolve claiming a different conversation must not settle the Future.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="conv-B") is False
    assert not fut.done()
    # The owning conversation can.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="conv-A") is True
    assert fut.result() is ApprovalDecision.APPROVE


async def test_registry_double_resolve_returns_false():
    reg = ApprovalRegistry()
    reg.create("a1", "c")
    assert reg.resolve("a1", ApprovalDecision.DENY, conversation_id="c") is True
    # Already settled → second resolve is rejected.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="c") is False


async def test_registry_discard_forgets_request():
    reg = ApprovalRegistry()
    reg.create("a1", "c")
    reg.discard("a1")
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="c") is False


# --- ApprovalGate ----------------------------------------------------------


async def test_gate_authorize_approve_emits_event_pair():
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "call-1", ApprovalDecision.APPROVE, "conv-1")
    )
    decision = await gate.authorize(
        tool_name="file_write", tool_call_id="call-1", arguments={"path": "a.txt"}
    )
    await resolver

    assert decision is ApprovalDecision.APPROVE
    types = [e.type for e in _drain(sink)]
    assert types == [EventType.APPROVAL_REQUIRED, EventType.APPROVAL_RESOLVED]


async def test_gate_authorize_times_out_to_deny():
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg, timeout_seconds=0.01)

    # No resolver — the request is never answered and must auto-deny.
    decision = await gate.authorize(
        tool_name="code_execute", tool_call_id="x", arguments={}
    )

    assert decision is ApprovalDecision.DENY
    resolved = [e for e in _drain(sink) if e.type is EventType.APPROVAL_RESOLVED]
    assert resolved and resolved[0].payload["decision"] == ApprovalDecision.DENY


async def test_gate_approve_always_skips_second_prompt():
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "id1", ApprovalDecision.APPROVE_ALWAYS, "conv-1")
    )
    first = await gate.authorize(
        tool_name="file_write", tool_call_id="id1", arguments={}
    )
    await resolver
    assert first is ApprovalDecision.APPROVE_ALWAYS

    _drain(sink)  # clear the first pair
    # Second call to the SAME tool returns immediately, with no new prompt.
    second = await gate.authorize(
        tool_name="file_write", tool_call_id="id2", arguments={}
    )
    assert second is ApprovalDecision.APPROVE
    assert _drain(sink) == []


async def test_gate_truncates_large_argument_preview():
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    big = "x" * 5000
    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "id1", ApprovalDecision.DENY, "conv-1")
    )
    await gate.authorize(
        tool_name="file_write", tool_call_id="id1", arguments={"content": big}
    )
    await resolver

    required = next(e for e in _drain(sink) if e.type is EventType.APPROVAL_REQUIRED)
    preview = required.payload["arguments"]["content"]
    assert len(preview) < len(big)
    assert preview.endswith("[truncated]")


# --- react_loop integration ------------------------------------------------


def _tool_chunk(name: str, args: str, *, call_id: str = "c") -> LLMChunk:
    return LLMChunk(
        delta_tool_calls=[
            ToolCallDelta(index=0, id=call_id, function_name=name, arguments_delta=args)
        ]
    )


def _content_chunk(text: str) -> LLMChunk:
    return LLMChunk(delta_content=text)


class _ScriptedProvider:
    def __init__(self, rounds: list[list[LLMChunk]]) -> None:
        self._rounds = rounds
        self.calls = 0

    async def stream(self, request):  # noqa: ANN001 - duck-typed for the loop
        chunks = self._rounds[self.calls] if self.calls < len(self._rounds) else []
        self.calls += 1
        for chunk in chunks:
            yield chunk


class _GrantableTool:
    """A GRANTABLE stub that records whether it actually executed."""

    def __init__(self, name: str = "file_write") -> None:
        self._name = name
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub grantable",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(tool_call_id="", success=True, output="wrote")


class _NeverGatedTool:
    """A non-GRANTABLE (SEARCH) stub — must run without any approval prompt."""

    def __init__(self, name: str = "search") -> None:
        self._name = name
        self.calls = 0

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=self._name,
            description="stub search",
            parameters={"type": "object", "properties": {}},
            category=ToolCategory.SEARCH,
        )

    async def execute(self, arguments, context) -> ToolResult:  # noqa: ANN001
        self.calls += 1
        return ToolResult(tool_call_id="", success=True, output="result")


def _registry(tool) -> ToolRegistry:  # noqa: ANN001
    reg = ToolRegistry()
    reg.register(tool)
    return reg


def _context() -> ToolContext:
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="a",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _profile() -> ModelProfile:
    return ModelProfile(model="m", thinking=False, reasoning_effort=None, max_rounds=20)


async def test_engine_gates_grantable_tool_runs_on_approve():
    provider = _ScriptedProvider(
        [[_tool_chunk("file_write", '{"path": "a.txt"}')], [_content_chunk("done")]]
    )
    tool = _GrantableTool()
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "c", ApprovalDecision.APPROVE, "conv-1")
    )
    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=_profile(),
        approval_gate=gate,
    )
    await resolver

    assert content == "done"
    assert tool.calls == 1  # approved → executed


async def test_engine_gates_grantable_tool_skips_on_deny():
    provider = _ScriptedProvider(
        [[_tool_chunk("file_write", '{"path": "a.txt"}')], [_content_chunk("ok")]]
    )
    tool = _GrantableTool()
    reg = ApprovalRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "c", ApprovalDecision.DENY, "conv-1")
    )
    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=_profile(),
        approval_gate=gate,
    )
    await resolver

    assert content == "ok"
    assert tool.calls == 0  # denied → never executed
    # The model was told, via a tool message, that the call was not authorized.
    denial = [
        m for m in messages if m.role == "tool" and "未获用户授权" in (m.content or "")
    ]
    assert len(denial) == 1


async def test_engine_does_not_gate_non_grantable_tool():
    provider = _ScriptedProvider(
        [[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]]
    )
    tool = _NeverGatedTool()
    sink = EventSink()
    # Gate present but the SEARCH tool is not GRANTABLE → must run un-gated.
    # A tiny timeout proves we never awaited an approval (would otherwise deny).
    gate = _gate(sink, ApprovalRegistry(), timeout_seconds=0.01)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]

    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=_profile(),
        approval_gate=gate,
    )

    assert content == "done"
    assert tool.calls == 1
    assert not any(e.type is EventType.APPROVAL_REQUIRED for e in _drain(sink))
