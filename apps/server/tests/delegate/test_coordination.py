"""CEO 协调模式 Phase 2：非阻塞 delegate + 事件队列 + budget。"""

from __future__ import annotations

import asyncio

from agentcore.runtime.coordination.journal import (
    CoordinationSnapshotFact,
    coordination_from_journal,
)
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    CoordinationSnapshot,
    active_coordination,
    clear_active_coordination,
    should_enter_coordination,
)
from agentcore.runtime.coordination.tools import CancelWorkerTool, UpdateSynthesisTool
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from tests.delegate.conftest import Provider, ctx, tool


def test_should_enter_coordination_gate():
    # Default-on: coordinate=True (or omitted at tool layer) + ≥2 + root + not finalize.
    assert should_enter_coordination(
        coordinate=True, worker_count=2, finalize=False, depth=0
    )
    # Explicit opt-out.
    assert not should_enter_coordination(
        coordinate=False, worker_count=2, finalize=False, depth=0
    )
    assert not should_enter_coordination(
        coordinate=True, worker_count=1, finalize=False, depth=0
    )
    assert not should_enter_coordination(
        coordinate=True, worker_count=2, finalize=True, depth=0
    )
    assert not should_enter_coordination(
        coordinate=True, worker_count=2, finalize=False, depth=1
    )


def test_coordination_snapshot_roundtrip():
    snap = CoordinationSnapshot(
        execution_id="e1",
        draft="草稿",
        completed_run_ids=["a"],
        budget_remaining=3,
        total_workers=2,
        pending_events=[{"kind": "worker_completed", "payload": {"run_id": "a"}}],
    )
    restored = CoordinationSnapshot.from_dict(snap.to_dict())
    assert restored is not None
    assert restored.draft == "草稿"
    assert restored.budget_remaining == 3
    session = CoordinationSession.from_snapshot(restored)
    assert session.draft == "草稿"
    assert "a" in session.completed_run_ids
    pending = session.drain_nowait()
    assert len(pending) == 1
    assert pending[0].kind is CoordinationEventKind.WORKER_COMPLETED


def test_coordination_from_journal():
    fact = CoordinationSnapshotFact(
        snapshot={
            "execution_id": "ex",
            "draft": "d",
            "completed_run_ids": [],
            "budget_remaining": 5,
            "total_workers": 2,
            "active": True,
        }
    ).to_fact()
    snap = coordination_from_journal([fact.entry()])
    assert snap is not None
    assert snap.draft == "d"
    assert snap.budget_remaining == 5


def test_necessary_decision_points():
    session = CoordinationSession(execution_id="e", total_workers=3, budget_remaining=1)
    first = [
        CoordinationEvent(
            kind=CoordinationEventKind.WORKER_COMPLETED,
            payload={"run_id": "w1"},
        )
    ]
    assert session.is_necessary_decision(first)
    session.note_decision_points(first)
    mid = [
        CoordinationEvent(
            kind=CoordinationEventKind.WORKER_COMPLETED,
            payload={"run_id": "w2"},
        )
    ]
    assert not session.is_necessary_decision(mid)
    assert session.is_necessary_decision(
        [CoordinationEvent(kind=CoordinationEventKind.ESCALATION, payload={})]
    )
    assert session.is_necessary_decision(
        [CoordinationEvent(kind=CoordinationEventKind.ALL_COMPLETED, payload={})]
    )


async def test_solo_worker_ignores_coordinate_flag():
    """金线：单 worker + coordinate=true 仍走阻塞路径，返回完整产物。"""
    t = tool(Provider(["SOLO_OUT"]))
    result = await t.execute(
        {
            "tasks": [{"role": "工程师", "task": "做一件事"}],
            "coordinate": True,
        },
        ctx(),
    )
    assert result.success is True
    assert result.is_terminal is False
    assert "SOLO_OUT" in result.output
    assert "团队已启动" not in result.output
    assert active_coordination() is None


async def test_multi_worker_omitted_coordinate_defaults_to_coordination():
    """金线：多 worker 省略 coordinate → 默认协调（立即返回『团队已启动』）。"""
    clear_active_coordination()
    t = tool(Provider(["AOUT", "BOUT"]))
    result = await t.execute(
        {"tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}]},
        ctx(),
    )
    assert result.success is True
    assert "团队已启动" in result.output
    assert "AOUT" not in result.output
    session = active_coordination("e")
    assert session is not None
    assert session.drive_task is not None
    await asyncio.wait_for(session.drive_task, timeout=10)
    clear_active_coordination("e")


async def test_multi_worker_explicit_coordinate_false_stays_blocking():
    """金线：多 worker + coordinate=false → 经典阻塞语义。"""
    t = tool(Provider(["AOUT", "BOUT"]))
    result = await t.execute(
        {
            "tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}],
            "coordinate": False,
        },
        ctx(),
    )
    assert result.success is True
    assert "AOUT" in result.output
    assert "BOUT" in result.output
    assert "团队已启动" not in result.output
    assert active_coordination() is None


async def test_coordinate_returns_immediately_and_posts_events():
    """coordinate=true + ≥2 worker → 立即返回；后台完成后投递 all_completed。"""
    clear_active_coordination()
    t = tool(Provider(["AOUT", "BOUT"]))
    result = await t.execute(
        {
            "tasks": [{"role": "研究员", "task": "做A"}, {"role": "写手", "task": "做B"}],
            "coordinate": True,
        },
        ctx(),
    )
    assert result.success is True
    assert "团队已启动" in result.output
    assert "AOUT" not in result.output  # not yet folded into tool result
    session = active_coordination("e")
    assert session is not None
    assert session.total_workers == 2
    assert session.drive_task is not None

    # Wait for background drive to finish and post all_completed.
    await asyncio.wait_for(session.drive_task, timeout=10)
    events = session.drain_nowait()
    kinds = [e.kind for e in events]
    assert CoordinationEventKind.WORKER_COMPLETED in kinds
    assert CoordinationEventKind.ALL_COMPLETED in kinds
    assert len(session.completed_run_ids) == 2
    clear_active_coordination("e")


async def test_update_synthesis_emits_preview():
    clear_active_coordination()
    sink = EventSink()
    session = CoordinationSession(execution_id="e", total_workers=2)
    from agentcore.runtime.coordination.session import set_active_coordination

    set_active_coordination(session)
    syn = UpdateSynthesisTool(sink=sink)
    result = await syn.execute({"draft": "进展中的合成草稿"}, ctx())
    assert result.success is True
    assert session.draft == "进展中的合成草稿"
    sink.close()
    previews = [
        e async for e in sink if e.type == EventType.TEAM_SYNTHESIS_PREVIEW
    ]
    assert len(previews) == 1
    assert previews[0].payload["text"] == "进展中的合成草稿"
    assert previews[0].payload["in_progress"] is True
    clear_active_coordination()


async def test_cancel_worker_requests_cancel():
    clear_active_coordination()
    session = CoordinationSession(execution_id="e", total_workers=2)
    from agentcore.runtime.coordination.session import set_active_coordination

    set_active_coordination(session)
    cancel = CancelWorkerTool()
    result = await cancel.execute({"run_id": "w1", "reason": "重复"}, ctx())
    assert result.success is True
    assert "w1" in session.cancel_run_ids()
    clear_active_coordination()


async def test_coord_tools_reject_outside_session():
    clear_active_coordination()
    syn = UpdateSynthesisTool(sink=EventSink())
    bad = await syn.execute({"draft": "x"}, ctx())
    assert bad.success is False
    cancel = CancelWorkerTool()
    bad2 = await cancel.execute({"run_id": "w1"}, ctx())
    assert bad2.success is False


async def test_budget_exhaustion_still_injects_template():
    from agentcore.runtime.coordination.wait import await_coordination_injection

    clear_active_coordination()
    session = CoordinationSession(
        execution_id="exec-b", total_workers=4, budget_remaining=0
    )
    session._saw_first_completion = True
    from agentcore.runtime.coordination.session import set_active_coordination

    set_active_coordination(session)
    session.post(
        CoordinationEvent(
            kind=CoordinationEventKind.WORKER_COMPLETED,
            payload={"run_id": "w2", "role": "B", "status": "completed", "summary": "ok"},
        )
    )
    msgs = await await_coordination_injection([])
    assert len(msgs) == 1
    assert "团队协调事件" in (msgs[0].content or "")
    assert session.budget_remaining == 0  # not decremented further
    clear_active_coordination()


async def test_worker_timeout_posts_event_without_cancel():
    """Phase 3: timer notifies CEO; worker is NOT auto-cancelled."""
    clear_active_coordination()
    from agentcore.runtime.coordination.session import set_active_coordination

    session = CoordinationSession(execution_id="exec-to", total_workers=2)
    set_active_coordination(session)
    session.arm_worker_timeout("w-slow", role="慢工", timeout_s=0.05)
    events = await session.wait_events(timeout=2.0)
    assert any(e.kind is CoordinationEventKind.TIMEOUT for e in events)
    timeout_ev = next(e for e in events if e.kind is CoordinationEventKind.TIMEOUT)
    assert timeout_ev.payload["run_id"] == "w-slow"
    assert timeout_ev.payload["role"] == "慢工"
    assert timeout_ev.payload["status"] == "running"
    assert timeout_ev.payload["elapsed_s"] >= 0.05
    assert "w-slow" not in session.cancel_run_ids()
    assert session.is_necessary_decision(events)
    session.disarm_worker_timeout("w-slow")
    clear_active_coordination()


async def test_worker_timeout_disarmed_on_completion():
    clear_active_coordination()
    session = CoordinationSession(execution_id="exec-to2", total_workers=2)
    session.arm_worker_timeout("w1", role="A", timeout_s=5.0)
    session.mark_worker_completed("w1")
    await asyncio.sleep(0.05)
    assert session.drain_nowait() == []
    clear_active_coordination()


async def test_escalate_routes_to_coordination_queue():
    """Phase 3: worker escalate posts into CEO queue when coordinating."""
    clear_active_coordination()
    from agentcore.runtime.coordination.bridge import post_escalation_to_coordination
    from agentcore.runtime.coordination.session import set_active_coordination

    session = CoordinationSession(execution_id="exec-esc", total_workers=2)
    set_active_coordination(session)
    assert post_escalation_to_coordination(
        run_id="r1",
        role="研究员",
        kind="scope",
        question="真实需求变了",
        assumption="按原 brief 继续",
    )
    events = session.drain_nowait()
    assert len(events) == 1
    assert events[0].kind is CoordinationEventKind.ESCALATION
    assert events[0].payload["kind"] == "scope"
    assert events[0].payload["question"] == "真实需求变了"
    # Dedupe: same signal twice → one event.
    assert not post_escalation_to_coordination(
        run_id="r1",
        role="研究员",
        kind="scope",
        question="真实需求变了",
    )
    assert session.drain_nowait() == []
    clear_active_coordination()


async def test_escalate_ignored_outside_coordination():
    clear_active_coordination()
    from agentcore.runtime.coordination.bridge import post_escalation_to_coordination

    assert not post_escalation_to_coordination(
        run_id="r1", kind="normal", question="无人协调"
    )


async def test_note_conflict_posts_escalation():
    clear_active_coordination()
    from agentcore.runtime.coordination.bridge import post_note_to_coordination
    from agentcore.runtime.coordination.session import set_active_coordination

    session = CoordinationSession(execution_id="exec-note", total_workers=2)
    set_active_coordination(session)
    post_note_to_coordination(
        run_id="r2",
        role="写手",
        kind="decision",
        text="POST /auth 用 password",
        conflict="⚠️ 与 研究员 的决定可能冲突",
    )
    events = session.drain_nowait()
    kinds = [e.kind for e in events]
    assert CoordinationEventKind.NOTE_POSTED in kinds
    assert CoordinationEventKind.ESCALATION in kinds
    esc = next(e for e in events if e.kind is CoordinationEventKind.ESCALATION)
    assert esc.payload["kind"] == "note_conflict"
    assert esc.payload["source"] == "note_wall"
    clear_active_coordination()


async def test_coordination_scope_boundary_proceeds():
    """SCOPE under coordination → PROCEED (no YIELD) + escalation event."""
    clear_active_coordination()
    from agentcore.runtime.coordination.bridge import coordination_boundary_hook
    from agentcore.runtime.coordination.session import set_active_coordination
    from agentcore.runtime.runs import BoundaryOutcome, BoundaryReason
    from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

    session = CoordinationSession(execution_id="exec-scope", total_workers=2)
    set_active_coordination(session)
    hook = coordination_boundary_hook(session, base_hook=None)
    node = RunSpec(run_id="a", role="研究员", task="调研", agent_name="研究员")
    state = RunState(
        phase=RunPhase.COMPLETED,
        content="ok",
        escalations=[{"kind": "scope", "question": "范围偏了", "consumed": False}],
    )
    outcome = await hook(BoundaryReason.SCOPE, [node], {"a": state})
    assert outcome is BoundaryOutcome.PROCEED
    events = session.drain_nowait()
    assert any(e.kind is CoordinationEventKind.ESCALATION for e in events)
    clear_active_coordination()


async def test_coordinate_react_loop_e2e(monkeypatch):
    """ReAct 全环：CEO delegate（省略 coordinate=默认协调）→ 波内 update_synthesis → 终稿。

    Drives the real ``react_loop`` (role=captain) with a scripted CEO provider and
    a separate worker LLM on DelegateTool — covers non-blocking arming,
    coordination event injection between rounds, synthesis draft preview on the
    sink, and final content after all_completed.
    """
    import json
    from pathlib import Path

    import agentcore.runtime.coordination.wait as coord_wait
    from agentcore.llm.provider.protocol import LLMChunk, LLMMessage, ToolCallDelta
    from agentcore.runtime.coordination.session import current_execution_id
    from agentcore.runtime.engine import react_loop
    from agentcore.tools.builtin.delegate import DelegateTool
    from agentcore.tools.protocol import ToolContext
    from agentcore.tools.registry import ToolRegistry
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace
    from tests.llm_helpers import make_profile_params

    # Keep idle-wait short if the race ever misses mid-wave events.
    monkeypatch.setattr(coord_wait, "_COORD_WAIT_TIMEOUT_S", 2.0)
    clear_active_coordination()
    sink = EventSink()
    draft_text = "进展中的合成草稿：两边方向一致，优先方案 A。"

    class _SlowSecondWorker:
        """First worker instant; second delayed past coalesce so CEO sees mid-wave."""

        def __init__(self) -> None:
            self.calls = 0

        async def stream(self, request):  # noqa: ANN001
            idx = self.calls
            self.calls += 1
            if idx >= 1:
                await asyncio.sleep(0.25)
            text = "AOUT" if idx == 0 else "BOUT"
            yield LLMChunk(delta_content=text)

    class _CoordCeoProvider:
        def __init__(self) -> None:
            self.delegate_calls = 0
            self.synth_calls = 0
            self.final_calls = 0

        async def stream(self, request):  # noqa: ANN001
            tool_msgs = [m for m in request.messages if m.role == "tool"]
            last_tool = (tool_msgs[-1].content or "") if tool_msgs else ""
            coord_injected = any(
                m.role == "user" and m.content and "团队协调事件" in m.content
                for m in request.messages
            )
            all_done = any(
                m.role == "user"
                and m.content
                and "all_completed" in m.content
                for m in request.messages
            )
            if not tool_msgs:
                self.delegate_calls += 1
                # Sequential deps + slow r2 → first completion wakes CEO alone.
                # Omit coordinate — D2 默认协调；显式 true 等价。
                args = json.dumps(
                    {
                        "tasks": [
                            {"id": "r1", "role": "研究员", "task": "做A"},
                            {
                                "id": "r2",
                                "role": "写手",
                                "task": "做B",
                                "depends_on": ["r1"],
                            },
                        ],
                    }
                )
                yield LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="ceo-dc1",
                            function_name="delegate",
                            arguments_delta=args,
                        )
                    ]
                )
            elif "已更新合成草稿" in last_tool or all_done:
                self.final_calls += 1
                yield LLMChunk(delta_content="最终合成：A 与 B 已对齐，按方案 A 定稿。")
            elif coord_injected and self.synth_calls == 0 and not all_done:
                self.synth_calls += 1
                args = json.dumps({"draft": draft_text})
                yield LLMChunk(
                    delta_tool_calls=[
                        ToolCallDelta(
                            index=0,
                            id="ceo-syn1",
                            function_name="update_synthesis",
                            arguments_delta=args,
                        )
                    ]
                )
            else:
                self.final_calls += 1
                yield LLMChunk(delta_content="最终合成：A 与 B 已对齐，按方案 A 定稿。")

    ceo_llm = _CoordCeoProvider()
    worker_llm = _SlowSecondWorker()
    base_ctx = ToolContext(
        execution_id="e-coord-e2e",
        run_id="cap",
        agent_id="cap",
        backend=ServerWorkspace(root=Path("."), sandbox=SubprocessSandbox()),
        user_id="u",
    )
    delegate = DelegateTool(
        llm=worker_llm,
        sink=sink,
        system_prompt="SYS",
        user_message="原始请求：并行做 A 和 B",
        history=[],
        tools=ToolRegistry(),
        base_tool_context=base_ctx,
    )
    reg = ToolRegistry()
    reg.register(delegate)
    reg.register(UpdateSynthesisTool(sink=sink))
    reg.register(CancelWorkerTool())

    messages: list[LLMMessage] = [
        LLMMessage(role="user", content="请协调团队并行完成 A 和 B"),
    ]
    exec_token = current_execution_id.set("e-coord-e2e")
    try:
        content, _reasoning, _usage, rounds = await react_loop(
            messages=messages,
            llm=ceo_llm,
            tools=reg,
            sink=sink,
            tool_context=base_ctx,
            profile=make_profile_params(max_rounds=12),
            turn_model="m",
            run_id="cap",
            role="captain",
        )
    finally:
        clear_active_coordination("e-coord-e2e")
        current_execution_id.reset(exec_token)

    assert ceo_llm.delegate_calls == 1
    assert ceo_llm.synth_calls == 1
    assert "最终合成" in content
    assert rounds >= 3
    assert any("团队协调事件" in (m.content or "") for m in messages if m.role == "user")

    sink.close()
    previews = [e async for e in sink if e.type == EventType.TEAM_SYNTHESIS_PREVIEW]
    assert any(e.payload.get("text") == draft_text for e in previews)
    assert worker_llm.calls >= 2


async def test_concurrent_sessions_isolated_by_execution_id():
    """棘轮：两个不同 execution_id 的并发 CoordinationSession 互不串扰。"""
    from agentcore.runtime.coordination.session import (
        current_execution_id,
        set_active_coordination,
    )

    clear_active_coordination()
    a = CoordinationSession(execution_id="exec-iso-a", total_workers=2)
    b = CoordinationSession(execution_id="exec-iso-b", total_workers=3)
    set_active_coordination(a)
    set_active_coordination(b)

    assert active_coordination("exec-iso-a") is a
    assert active_coordination("exec-iso-b") is b
    assert active_coordination("exec-iso-a") is not active_coordination("exec-iso-b")

    a.update_draft("草稿 A")
    b.update_draft("草稿 B")
    a.post(
        CoordinationEvent(
            kind=CoordinationEventKind.WORKER_COMPLETED,
            payload={"run_id": "wa"},
        )
    )
    b.post(
        CoordinationEvent(
            kind=CoordinationEventKind.NOTE_POSTED,
            payload={"run_id": "wb", "text": "note-b"},
        )
    )

    assert a.draft == "草稿 A"
    assert b.draft == "草稿 B"
    assert active_coordination("exec-iso-a").draft == "草稿 A"
    assert active_coordination("exec-iso-b").draft == "草稿 B"

    ev_a = a.drain_nowait()
    ev_b = b.drain_nowait()
    assert len(ev_a) == 1 and ev_a[0].kind is CoordinationEventKind.WORKER_COMPLETED
    assert len(ev_b) == 1 and ev_b[0].kind is CoordinationEventKind.NOTE_POSTED
    assert a.drain_nowait() == []
    assert b.drain_nowait() == []

    # ContextVar resolves to the last set_active in this context (b).
    assert current_execution_id.get() == "exec-iso-b"
    assert active_coordination() is b

    clear_active_coordination("exec-iso-a")
    assert active_coordination("exec-iso-a") is None
    assert active_coordination("exec-iso-b") is b
    assert b.draft == "草稿 B"

    clear_active_coordination("exec-iso-b")
    assert active_coordination("exec-iso-b") is None
    clear_active_coordination()


async def test_coordination_checkpoint_yields_without_durable_pause(monkeypatch):
    """选项 1：协调态 + checkpoint_after → BOUNDARY_YIELD，不 persist / 不 seal / 不收口。"""
    from agentcore.runtime.suspension import TurnSuspension
    from tests.delegate.conftest import CKPT_DAG, tool_durable

    monkeypatch.setattr(
        "agentcore.tools.builtin.delegate.preview.should_preview",
        lambda *a, **k: False,
    )
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TurnSuspension] = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(_mid):
        pass

    t = tool_durable(Provider(["S1OUT", "S2OUT"]), sink, registry, _save, _drop)
    result = await t.execute({"tasks": CKPT_DAG}, ctx())
    assert result.success is True
    assert "团队已启动" in result.output

    session = active_coordination("e")
    assert session is not None and session.drive_task is not None
    await asyncio.wait_for(session.drive_task, timeout=10)

    assert saved == [], "协调态 checkpoint 不得 persist TurnSuspension"
    assert t._pending_pause is False
    assert t._pending_boundary is None

    events = session.drain_nowait()
    kinds = [e.kind for e in events]
    assert CoordinationEventKind.BOUNDARY_YIELD in kinds
    byield = next(e for e in events if e.kind is CoordinationEventKind.BOUNDARY_YIELD)
    assert byield.payload.get("reason") == "checkpoint"
    brief = byield.payload.get("brief") or ""
    assert "checkpoint" in brief.lower() or "检查点" in brief

    # No plan_review_required as turn-closure card (协调态不发收口事件).
    assert not any(e.type is EventType.PLAN_REVIEW_REQUIRED for e in sink._history)
    clear_active_coordination("e")


async def test_classic_checkpoint_still_durable_when_not_coordinating(monkeypatch):
    """经典阻塞 path（coordinate=false）仍 durable plan_review 挂起即收口。"""
    from agentcore.core.types import ToolEffect
    from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
    from agentcore.runtime.suspension import TurnSuspension, captain_transcript
    from tests.delegate.conftest import CKPT_DAG, tool_durable

    monkeypatch.setattr(
        "agentcore.tools.builtin.delegate.preview.should_preview",
        lambda *a, **k: False,
    )
    clear_active_coordination()
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list[TurnSuspension] = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(_mid):
        pass

    t = tool_durable(Provider(["S1OUT", "S2OUT"]), sink, registry, _save, _drop)
    transcript = [
        LLMMessage(role="user", content="原始请求"),
        LLMMessage(
            role="assistant",
            content=None,
            tool_calls=[
                ToolCall(
                    id="call_del",
                    function=ToolCallFunction(name="delegate", arguments="{}"),
                )
            ],
        ),
    ]
    token = captain_transcript.set(transcript)
    try:
        result = await t.execute({"tasks": CKPT_DAG, "coordinate": False}, ctx())
    finally:
        captain_transcript.reset(token)

    assert result.effect is ToolEffect.SUSPEND
    assert len(saved) == 1
    assert any(e.type is EventType.PLAN_REVIEW_REQUIRED for e in sink._history)
