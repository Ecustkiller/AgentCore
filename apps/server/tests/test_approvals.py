"""Tests for the tool approval gate (CEO chat path).

Covers three layers:
  * ``InteractionRegistry`` — the in-process bridge: unknown / double / wrong-
    conversation resolves are refused; a matching resolve settles the Future.
  * ``ApprovalGate`` — per-turn suspension: approve, timeout→deny, and
    "approve for the rest of the turn" skipping the second prompt; plus the
    required→resolved event pair.
  * ``react_loop`` integration — a GRANTABLE tool is gated (runs on approve,
    skipped with a denial tool-message on deny), while a non-GRANTABLE tool runs
    un-gated even when a gate is present.
"""

import asyncio
import time
from pathlib import Path

import pytest

from agentcore.config.approval import ApprovalSettings
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, ToolCallDelta
from agentcore.runtime.approvals import (
    ApprovalDecision,
    ApprovalGate,
    DelegationAuthorizationDecision,
    tool_call_requires_approval,
)
from agentcore.runtime.engine import react_loop
from agentcore.runtime.events import EventSink, EventType, SSEEvent
from agentcore.runtime.interaction import InteractionKind, InteractionRegistry
from agentcore.tools.builtin import (
    build_builtin_registry,
    delegation_grantable_tool_names,
    per_call_tool_names,
)
from agentcore.tools.builtin.test_run import TestRunTool
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registry import ToolRegistry
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace
from tests.llm_helpers import make_profile_params

pytestmark = pytest.mark.anyio


# --- helpers ---------------------------------------------------------------


def _drain(sink: EventSink) -> list[SSEEvent]:
    """Pop every event currently queued on the sink (test inspection)."""
    events: list[SSEEvent] = []
    while not sink._queue.empty():  # noqa: SLF001 - test-only inspection
        events.append(sink._queue.get_nowait())
    return events


async def _resolve_when_ready(
    registry: InteractionRegistry,
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
    registry: InteractionRegistry,
    *,
    conversation_id: str = "conv-1",
    timeout_seconds: float = 5.0,
    timeout_overrides: dict[str, float] | None = None,
    delegation_grantable_tools: frozenset[str] | None = None,
) -> ApprovalGate:
    return ApprovalGate(
        sink=sink,
        conversation_id=conversation_id,
        registry=registry,
        timeout_seconds=timeout_seconds,
        timeout_overrides=timeout_overrides or {},
        delegation_grantable_tools=delegation_grantable_tools or delegation_grantable_tool_names(),
    )


# --- InteractionRegistry ------------------------------------------------------


async def test_registry_resolve_unknown_returns_false():
    reg = InteractionRegistry()
    assert reg.resolve("nope", ApprovalDecision.APPROVE, conversation_id="c") is False


async def test_registry_rejects_wrong_conversation():
    reg = InteractionRegistry()
    fut = reg.create("a1", "conv-A", kind=InteractionKind.APPROVAL)
    # A resolve claiming a different conversation must not settle the Future.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="conv-B") is False
    assert not fut.done()
    # The owning conversation can.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="conv-A") is True
    assert fut.result() is ApprovalDecision.APPROVE


async def test_registry_double_resolve_returns_false():
    reg = InteractionRegistry()
    reg.create("a1", "c", kind=InteractionKind.APPROVAL)
    assert reg.resolve("a1", ApprovalDecision.DENY, conversation_id="c") is True
    # Already settled → second resolve is rejected.
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="c") is False


async def test_registry_discard_forgets_request():
    reg = InteractionRegistry()
    reg.create("a1", "c", kind=InteractionKind.APPROVAL)
    reg.discard("a1")
    assert reg.resolve("a1", ApprovalDecision.APPROVE, conversation_id="c") is False


# --- ApprovalGate ----------------------------------------------------------


async def test_gate_authorize_approve_emits_event_pair():
    reg = InteractionRegistry()
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
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg, timeout_seconds=0.01)

    # No resolver — the request is never answered and must auto-deny.
    decision = await gate.authorize(tool_name="code_execute", tool_call_id="x", arguments={})

    assert decision is ApprovalDecision.DENY
    resolved = [e for e in _drain(sink) if e.type is EventType.APPROVAL_RESOLVED]
    assert resolved and resolved[0].payload["decision"] == ApprovalDecision.DENY


async def test_gate_per_tool_timeout_override():
    """A tool in timeout_overrides waits longer than the gate default."""
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(
        sink,
        reg,
        timeout_seconds=0.05,
        timeout_overrides={"file_write": 0.35},
    )

    started = time.monotonic()
    pending = asyncio.create_task(
        gate.authorize(tool_name="file_write", tool_call_id="fw-1", arguments={"path": "a.md"})
    )
    await asyncio.sleep(0.12)
    assert not pending.done()

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "fw-1", ApprovalDecision.APPROVE, "conv-1")
    )
    decision = await pending
    await resolver
    elapsed = time.monotonic() - started

    assert decision is ApprovalDecision.APPROVE
    assert elapsed >= 0.1

    # Other tools still use the short default.
    t0 = time.monotonic()
    deny = await gate.authorize(tool_name="code_execute", tool_call_id="ce-1", arguments={})
    assert deny is ApprovalDecision.DENY
    assert time.monotonic() - t0 < 0.2


def test_approval_settings_file_write_default_timeout():
    settings = ApprovalSettings()
    assert settings.approval_timeout_seconds == 300.0
    assert settings.approval_timeout_for("file_write") == 900.0
    assert settings.approval_timeout_for("code_execute") == 300.0


async def test_gate_approve_always_skips_second_prompt():
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "id1", ApprovalDecision.APPROVE_ALWAYS, "conv-1")
    )
    first = await gate.authorize(tool_name="file_write", tool_call_id="id1", arguments={})
    await resolver
    assert first is ApprovalDecision.APPROVE_ALWAYS

    _drain(sink)  # clear the first pair
    # Second call to the SAME tool returns immediately, with no new prompt.
    second = await gate.authorize(tool_name="file_write", tool_call_id="id2", arguments={})
    assert second is ApprovalDecision.APPROVE
    assert _drain(sink) == []


async def test_approve_always_sweeps_pending_same_tool():
    """'本轮内都允许' on one file_write retroactively approves the OTHER file_writes
    already suspended on the shared gate (parallel workers in local mode), so one
    click clears every pending same-tool prompt; a different tool stays gated.

    Closes the race the client's optimistic sibling-approve can miss (a sibling's
    approval_required SSE not yet in the store at click time): the registry is the
    authoritative pending set, so the sweep here catches it regardless.
    """
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    # Two file_writes + one code_execute suspended in parallel on the SAME gate.
    a = asyncio.create_task(gate.authorize(tool_name="file_write", tool_call_id="a", arguments={}))
    b = asyncio.create_task(gate.authorize(tool_name="file_write", tool_call_id="b", arguments={}))
    c = asyncio.create_task(
        gate.authorize(tool_name="code_execute", tool_call_id="c", arguments={})
    )
    # Let all three register before the grant, so the sweep can see b and c.
    for _ in range(2000):
        if len(reg.list_pending("conv-1")) == 3:
            break
        await asyncio.sleep(0)
    assert len(reg.list_pending("conv-1")) == 3

    # Grant file_write for the turn on call "a".
    assert reg.resolve("a", ApprovalDecision.APPROVE_ALWAYS, conversation_id="conv-1")

    assert await a is ApprovalDecision.APPROVE_ALWAYS
    # b (same tool) was swept to APPROVE without ever getting its own resolve.
    assert await b is ApprovalDecision.APPROVE
    # c (different tool) is untouched — still pending until resolved on its own.
    assert reg.resolve("c", ApprovalDecision.DENY, conversation_id="conv-1")
    assert await c is ApprovalDecision.DENY


async def test_approve_always_files_grants_whole_class():
    """'本轮内允许所有文件改动' grants the file-mutation class for the turn (so a LATER
    write/edit/delete/move auto-approves) and sweeps every already-suspended file-op
    call — while code_execute, outside the class, stays separately gated."""
    reg = InteractionRegistry()
    sink = EventSink()
    file_ops = frozenset({"file_write", "file_append", "str_replace", "file_delete", "file_move"})
    gate = ApprovalGate(
        sink=sink,
        conversation_id="conv-1",
        registry=reg,
        timeout_seconds=5.0,
        file_op_tools=file_ops,
    )

    # A file_write (the clicked card), a parallel str_replace, and a code_execute.
    w = asyncio.create_task(gate.authorize(tool_name="file_write", tool_call_id="w", arguments={}))
    r = asyncio.create_task(gate.authorize(tool_name="str_replace", tool_call_id="r", arguments={}))
    x = asyncio.create_task(
        gate.authorize(tool_name="code_execute", tool_call_id="x", arguments={})
    )
    for _ in range(2000):
        if len(reg.list_pending("conv-1")) == 3:
            break
        await asyncio.sleep(0)
    assert len(reg.list_pending("conv-1")) == 3

    # Click "allow all file edits" on the file_write card.
    assert reg.resolve("w", ApprovalDecision.APPROVE_ALWAYS_FILES, conversation_id="conv-1")
    assert await w is ApprovalDecision.APPROVE_ALWAYS_FILES
    # str_replace (in the class) was swept to APPROVE without its own resolve.
    assert await r is ApprovalDecision.APPROVE
    # code_execute (NOT in the class) is untouched — still gated until resolved.
    assert reg.resolve("x", ApprovalDecision.DENY, conversation_id="conv-1")
    assert await x is ApprovalDecision.DENY

    # A LATER file_delete (also in the class) is now auto-approved, no new prompt.
    _drain(sink)
    later = await gate.authorize(tool_name="file_delete", tool_call_id="d", arguments={})
    assert later is ApprovalDecision.APPROVE
    assert _drain(sink) == []
    # But a LATER code_execute still prompts (the class grant never covered it).
    resolver = asyncio.create_task(_resolve_when_ready(reg, "x2", ApprovalDecision.DENY, "conv-1"))
    later_exec = await gate.authorize(tool_name="code_execute", tool_call_id="x2", arguments={})
    await resolver
    assert later_exec is ApprovalDecision.DENY


async def test_per_call_tool_grant_downgraded_to_one_shot():
    """code_execute is per-call: a「本轮内都允许」(APPROVE_ALWAYS) is downgraded to a
    one-shot APPROVE and NOT whitelisted, so the next code_execute call prompts again —
    injected content later in the turn can't ride the earlier grant (PI-004)."""
    reg = InteractionRegistry()
    sink = EventSink()
    gate = ApprovalGate(
        sink=sink,
        conversation_id="conv-1",
        registry=reg,
        timeout_seconds=5.0,
        per_call_tools=frozenset({"code_execute"}),
    )

    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "id1", ApprovalDecision.APPROVE_ALWAYS, "conv-1")
    )
    first = await gate.authorize(tool_name="code_execute", tool_call_id="id1", arguments={})
    await resolver
    assert first is ApprovalDecision.APPROVE  # downgraded from APPROVE_ALWAYS

    _drain(sink)
    # The SECOND code_execute is NOT auto-approved — it must prompt again (deny to prove).
    resolver2 = asyncio.create_task(
        _resolve_when_ready(reg, "id2", ApprovalDecision.DENY, "conv-1")
    )
    second = await gate.authorize(tool_name="code_execute", tool_call_id="id2", arguments={})
    await resolver2
    assert second is ApprovalDecision.DENY
    assert any(e.type is EventType.APPROVAL_REQUIRED for e in _drain(sink))


async def test_per_call_tool_does_not_affect_other_tools_turn_grant():
    """The per-call exemption is scoped to its tools: a file_write APPROVE_ALWAYS still
    whitelists file_write for the turn (the existing batch放行 path is unchanged)."""
    reg = InteractionRegistry()
    sink = EventSink()
    gate = ApprovalGate(
        sink=sink,
        conversation_id="conv-1",
        registry=reg,
        timeout_seconds=5.0,
        per_call_tools=frozenset({"code_execute"}),
    )
    resolver = asyncio.create_task(
        _resolve_when_ready(reg, "w1", ApprovalDecision.APPROVE_ALWAYS, "conv-1")
    )
    first = await gate.authorize(tool_name="file_write", tool_call_id="w1", arguments={})
    await resolver
    assert first is ApprovalDecision.APPROVE_ALWAYS

    _drain(sink)
    second = await gate.authorize(tool_name="file_write", tool_call_id="w2", arguments={})
    assert second is ApprovalDecision.APPROVE  # whitelisted for the turn, no new prompt
    assert _drain(sink) == []


def test_per_call_tool_names_is_the_code_execution_class():
    """The single-source helper marks the whole code-execution class (GRANTABLE ∩
    EXECUTION = code_execute + test_run) per-call, and NOT the file-mutation tools
    (which keep the turn / class grant). test_run joins purely by its schema, no
    hardcoded name."""
    names = per_call_tool_names()
    assert "code_execute" in names
    assert "test_run" in names
    assert "file_write" not in names and "str_replace" not in names


def test_test_run_is_governed_by_the_approval_gate():
    """P0 invariant: test_run runs project code through the SAME sandbox chain as
    code_execute, so it must pass the approval gate — it must NOT be NEVER (which slipped
    the gate entirely). Pinned at the class level: its schema is GRANTABLE, so the same
    ``tool_call_requires_approval`` path that gates code_execute gates it, and it lands in
    the per-call class. This is the governance test the tool previously lacked."""
    schema = TestRunTool().schema
    assert schema.approval is ToolApproval.GRANTABLE
    assert schema.category is ToolCategory.EXECUTION
    # The gate (tool_exec.py consults this) now returns True for test_run, exactly as it
    # does for code_execute — no per-tool branch, just the shared GRANTABLE path.
    assert tool_call_requires_approval("test_run", schema.approval, {}) is True
    assert (
        tool_call_requires_approval("code_execute", schema.approval, {}) is True
    )  # same path
    # And it is confirmed per call (never turn-whitelisted), like code_execute.
    assert "test_run" in per_call_tool_names()
    # The registered instance carries the same governed schema (single source).
    assert build_builtin_registry().get("test_run").schema.approval is ToolApproval.GRANTABLE


async def test_gate_truncates_large_argument_preview():
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    big = "x" * 5000
    resolver = asyncio.create_task(_resolve_when_ready(reg, "id1", ApprovalDecision.DENY, "conv-1"))
    await gate.authorize(tool_name="file_write", tool_call_id="id1", arguments={"content": big})
    await resolver

    required = next(e for e in _drain(sink) if e.type is EventType.APPROVAL_REQUIRED)
    preview = required.payload["arguments"]["content"]
    assert len(preview) < len(big)
    assert preview.endswith("[truncated]")


async def test_gate_code_execute_code_preview_allows_20k():
    from agentcore.runtime.approvals import _PREVIEW_CODE_EXECUTE_CODE_MAX, _TRUNCATION_SUFFIX

    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    code = "c" * (_PREVIEW_CODE_EXECUTE_CODE_MAX + 500)
    purpose = "p" * 800
    resolver = asyncio.create_task(_resolve_when_ready(reg, "id1", ApprovalDecision.DENY, "conv-1"))
    await gate.authorize(
        tool_name="code_execute",
        tool_call_id="id1",
        arguments={"code": code, "purpose": purpose},
    )
    await resolver

    required = next(e for e in _drain(sink) if e.type is EventType.APPROVAL_REQUIRED)
    args = required.payload["arguments"]
    assert args["code"].endswith(_TRUNCATION_SUFFIX)
    assert len(args["code"]) == _PREVIEW_CODE_EXECUTE_CODE_MAX + len(_TRUNCATION_SUFFIX)
    assert args["purpose"].endswith(_TRUNCATION_SUFFIX)
    assert len(args["purpose"]) < len(purpose)


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


def _profile():
    return make_profile_params(max_rounds=20)


async def test_engine_gates_grantable_tool_runs_on_approve():
    provider = _ScriptedProvider(
        [[_tool_chunk("file_write", '{"path": "a.txt"}')], [_content_chunk("done")]]
    )
    tool = _GrantableTool()
    reg = InteractionRegistry()
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
        turn_model="m",
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
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]

    resolver = asyncio.create_task(_resolve_when_ready(reg, "c", ApprovalDecision.DENY, "conv-1"))
    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=_profile(),
        turn_model="m",
        approval_gate=gate,
    )
    await resolver

    assert content == "ok"
    assert tool.calls == 0  # denied → never executed
    # The model was told, via a tool message, that the call was not authorized.
    denial = [m for m in messages if m.role == "tool" and "未获用户授权" in (m.content or "")]
    assert len(denial) == 1


async def test_engine_does_not_gate_non_grantable_tool():
    provider = _ScriptedProvider([[_tool_chunk("search", '{"q": "x"}')], [_content_chunk("done")]])
    tool = _NeverGatedTool()
    sink = EventSink()
    # Gate present but the SEARCH tool is not GRANTABLE → must run un-gated.
    # A tiny timeout proves we never awaited an approval (would otherwise deny).
    gate = _gate(sink, InteractionRegistry(), timeout_seconds=0.01)
    messages: list[LLMMessage] = [LLMMessage(role="user", content="go")]

    content, *_ = await react_loop(
        messages=messages,
        llm=provider,
        tools=_registry(tool),
        sink=sink,
        tool_context=_context(),
        profile=_profile(),
        turn_model="m",
        approval_gate=gate,
    )

    assert content == "done"
    assert tool.calls == 1
    assert not any(e.type is EventType.APPROVAL_REQUIRED for e in _drain(sink))


async def _resolve_delegation_when_ready(
    registry: InteractionRegistry,
    authorization_id: str,
    decision: DelegationAuthorizationDecision,
    conversation_id: str,
) -> None:
    for _ in range(2000):
        if registry.resolve(authorization_id, decision, conversation_id=conversation_id):
            return
        await asyncio.sleep(0)
    raise AssertionError(f"delegation authorization {authorization_id!r} never became pending")


async def test_delegation_authorization_emits_event_pair():
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)

    resolver = asyncio.create_task(
        _resolve_delegation_when_ready(
            reg,
            "delegation-exec-1",
            DelegationAuthorizationDecision.GRANT_DELEGATION,
            "conv-1",
        )
    )
    decision = await gate.request_delegation_authorization(
        execution_id="exec-1",
        workers=[{"role": "研究员", "task_preview": "调研竞品"}],
    )
    await resolver

    assert decision is DelegationAuthorizationDecision.GRANT_DELEGATION
    events = _drain(sink)
    assert [e.type for e in events] == [
        EventType.DELEGATION_AUTHORIZATION_REQUIRED,
        EventType.DELEGATION_AUTHORIZATION_RESOLVED,
    ]
    assert events[0].payload["workers"][0]["role"] == "研究员"
    assert "code_execute" in events[0].payload["tools"]
    assert "exec-1" in gate._delegation_grants  # noqa: SLF001


async def test_delegation_grant_skips_code_execute_approval():
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg)
    from agentcore.runtime.approvals import DelegationGrant

    gate._delegation_grants["exec-1"] = DelegationGrant(execution_id="exec-1")  # noqa: SLF001

    decision = await gate.authorize(
        tool_name="code_execute",
        tool_call_id="ce-1",
        arguments={"code": "print(1)"},
        execution_id="exec-1",
    )
    assert decision is ApprovalDecision.APPROVE
    assert _drain(sink) == []


async def test_delegation_grant_revoked_restores_per_call():
    reg = InteractionRegistry()
    sink = EventSink()
    gate = _gate(sink, reg, timeout_seconds=0.01)
    from agentcore.runtime.approvals import DelegationGrant

    gate._delegation_grants["exec-1"] = DelegationGrant(execution_id="exec-1")  # noqa: SLF001
    gate.revoke_delegation("exec-1")

    decision = await gate.authorize(
        tool_name="code_execute",
        tool_call_id="ce-1",
        arguments={},
        execution_id="exec-1",
    )
    assert decision is ApprovalDecision.DENY


def test_delegation_grantable_tool_names_includes_code_execute_and_file_ops():
    names = delegation_grantable_tool_names()
    assert "code_execute" in names
    assert "file_write" in names
    assert "test_run" not in names
