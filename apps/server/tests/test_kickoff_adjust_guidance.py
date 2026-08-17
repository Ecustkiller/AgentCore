"""开工卡调整：CEO tool result 软引导（不硬闸、不套用取消话术）。"""

from __future__ import annotations

import pytest

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink
from agentcore.runtime.kickoff.adjust_guidance import (
    KICKOFF_ADJUST_GUIDANCE_DEBATE,
    KICKOFF_ADJUST_GUIDANCE_DELEGATE,
    format_kickoff_adjust_result,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState


def test_format_kickoff_adjust_result_delegate_and_debate():
    d = format_kickoff_adjust_result(primitive="delegate")
    assert "用户要求调整开工方案，团队未启动。" in d
    assert KICKOFF_ADJUST_GUIDANCE_DELEGATE in d
    assert "重新调用 delegate" in d
    assert "做不到" in d
    assert "禁止静默忽略" in d
    assert "宜先问" not in d
    assert "取消了开工" not in d

    b = format_kickoff_adjust_result(primitive="debate")
    assert "用户要求调整开赛方案，辩论未开赛。" in b
    assert KICKOFF_ADJUST_GUIDANCE_DEBATE in b
    assert "重新调用 debate" in b
    assert "做不到" in b
    assert "宜先问" not in b
    assert "取消了辩论" not in b

    with_note = format_kickoff_adjust_result(primitive="delegate", note="  人太多  ")
    assert "人太多" in with_note
    assert "用户意见：" in with_note
    assert KICKOFF_ADJUST_GUIDANCE_DELEGATE in with_note


@pytest.mark.asyncio
async def test_finalize_stopped_kickoff_adjusted_overrides_ceo_format():
    from agentcore.runtime.delegate.supervised import finalize_stopped
    from tests.delegate.conftest import Provider, tool

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", agent_id="a", role="调研", task="t1"),
            RunSpec(run_id="b", agent_id="b", role="写手", task="t2"),
        ]
    )
    t = tool(Provider([]))

    adjusted = await finalize_stopped(t, plan, {}, kickoff_adjusted=True, note="人太多")
    assert "用户要求调整开工方案" in adjusted.output
    assert "人太多" in adjusted.output
    assert "重新调用 delegate" in adjusted.output
    assert "宜先问" not in adjusted.output
    assert "团队执行结果" not in adjusted.output


@pytest.mark.asyncio
async def test_resume_plan_kickoff_adjust_no_grant_no_drive():
    """team_preview ADJUST：不 grant、不跑 worker，回灌修订引导。"""
    from tests.delegate.conftest import Provider, gate, resume_plan, tool

    plan = resume_plan()
    provider = Provider(["SHOULD_NOT_RUN"])
    approval = gate()
    t = tool(provider)
    t._approval_gate = approval

    kickoff_adjust = await t.resume_plan(
        plan,
        {},
        decision=CheckpointDecision.ADJUST,
        note="人太多，改成两人",
        checkpoint_run_ids=set(),
        execution_id="e-kickoff-adjust",
        apply_kickoff_grant=True,
    )
    assert "用户要求调整开工方案" in kickoff_adjust.output
    assert "人太多，改成两人" in kickoff_adjust.output
    assert "重新调用 delegate" in kickoff_adjust.output
    assert "宜先问" not in kickoff_adjust.output
    assert "团队执行结果" not in kickoff_adjust.output
    assert provider.calls == 0
    assert not approval.has_delegation_grant("e-kickoff-adjust")


@pytest.mark.asyncio
async def test_resume_plan_plan_review_adjust_still_steers():
    """plan_review ADJUST 仍 steer + drive（与开工卡分叉）。"""
    from tests.delegate.conftest import Provider, resume_plan, tool

    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.ADJUST,
        note="把重点放在风险上",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e-review-adjust",
        apply_kickoff_grant=False,
    )
    assert "S2OUT" in result.output
    assert provider.calls == 1
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "把重点放在风险上" in s2_user


@pytest.mark.asyncio
async def test_drive_preview_adjust_does_not_start_workers(monkeypatch):
    from agentcore.core.types import AutonomyPolicy
    from agentcore.runtime.delegate import preview as preview_mod
    from agentcore.runtime.delegate.drive_preview import team_preview_before_workers
    from tests.delegate.conftest import Provider, tool

    async def _fake_await(*_a, **_k):
        return CheckpointDecision.ADJUST

    monkeypatch.setattr(preview_mod, "await_team_preview", _fake_await)
    monkeypatch.setattr(preview_mod, "should_kickoff", lambda *a, **k: True)
    monkeypatch.setattr(preview_mod, "needs_capability_auth", lambda *a, **k: False)

    provider = Provider(["SHOULD_NOT_RUN"])
    real = tool(provider)
    real._depth = 0
    real._pending_pause = False
    real._active_playbook = None
    real._permission_axes = AutonomyPolicy.LESS_INTERRUPT

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", agent_id="a", role="调研", task="t1"),
            RunSpec(run_id="b", agent_id="b", role="写手", task="t2"),
        ]
    )
    result = await team_preview_before_workers(
        real,
        plan,
        complexity_hint="standard",
        seed_completed=None,
        call_idx=0,
    )
    assert result is not None
    assert "用户要求调整开工方案" in result.output
    assert "宜先问" not in result.output
    assert provider.calls == 0


@pytest.mark.asyncio
async def test_recover_window_team_preview_adjust_skips_continuity_steer(monkeypatch):
    """team_preview ADJUST feeds CEO but must not inject deliverable continuity steer."""
    from unittest.mock import AsyncMock, MagicMock

    from agentcore.core.types import ToolEffect
    from agentcore.llm.provider.protocol import LLMMessage, ToolCall, ToolCallFunction
    from agentcore.runtime.pipeline.resume import recover_path as rp
    from agentcore.runtime.recover import SettledSuspension
    from agentcore.runtime.suspension import TeamPreviewSuspension

    plan = RunPlan(nodes=[RunSpec(run_id="w1", task="t", role="研究员")])
    suspension = TeamPreviewSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="ck_tp",
        tool_call_id="call_del",
        user_message="task",
        base_system_prompt="sys",
        journal_entries=[],
        plan=plan,
        workers=[{"run_id": "w1", "role": "研究员", "task": "t"}],
        transcript=[],
    )
    suspension.transcript = [
        LLMMessage(role="user", content="组个队"),
        LLMMessage(
            role="assistant",
            content="方向：派团队 — 直接开委派。",
            tool_calls=[
                ToolCall(
                    id="call_del",
                    function=ToolCallFunction(name="delegate", arguments="{}"),
                )
            ],
        ),
    ]
    monkeypatch.setattr(
        rp,
        "resumed_captain_window",
        lambda _s, _h: list(suspension.transcript),
    )
    monkeypatch.setattr(
        rp,
        "recover_turn",
        AsyncMock(
            return_value=SettledSuspension(
                format_kickoff_adjust_result(primitive="delegate", note="人太多"),
                None,
                ToolEffect.CONTINUE,
            ),
        ),
    )
    monkeypatch.setattr(rp, "persist_resumed_tool_results", MagicMock())
    monkeypatch.setattr(
        rp,
        "append_resumed_tool_results",
        lambda msgs, _id, output: msgs.append(
            LLMMessage(role="tool", content=output, tool_call_id="call_del")
        ),
    )

    recovered = await rp.recover_and_rebuild_window(
        suspension=suspension,
        decision=CheckpointDecision.ADJUST,
        note="人太多",
        selected=[],
        history=None,
        sink=EventSink(),
        delegate_tool=MagicMock(),
        debate_tool=MagicMock(),
        execution_id="e1",
        captain_run_id="cap1",
        pre_pause_override="方向：派团队 — 直接开委派。",
    )
    assert recovered.settled.terminal_text is None
    assert recovered.messages[-1].role == "tool"
    assert "用户要求调整开工方案" in (recovered.messages[-1].content or "")
    assert not any(
        m.role == "user" and "[系统提示]" in (m.content or "") for m in recovered.messages
    )


@pytest.mark.asyncio
async def test_recover_debate_adjust_no_execute_and_no_terminal():
    """Debate team_preview ADJUST：resume_after_kickoff 回灌，不升格终态。"""
    from unittest.mock import AsyncMock, MagicMock

    from agentcore.core.types import ToolEffect
    from agentcore.runtime.recover import recover_turn
    from agentcore.runtime.suspension import TeamPreviewSuspension
    from agentcore.runtime.turn.state import TurnState
    from agentcore.tools.protocol import ToolResult

    prior = [
        {
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "tp0", "decision": "adjust", "note": "一"},
            "ts": "t0",
        },
        {
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "tp1", "decision": "adjust", "note": "二"},
            "ts": "t1",
        },
    ]
    frame = TeamPreviewSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="ck_tp",
        tool_call_id="call_db",
        user_message="辩一下",
        base_system_prompt="sys",
        journal_entries=prior,
        plan=RunPlan(),
        primitive="debate",
        debate_arguments={"motion": "原命题", "form": "debate"},
        transcript=[],
    )
    debate = MagicMock()
    debate.resume_after_kickoff = AsyncMock(
        return_value=ToolResult(
            tool_call_id="",
            success=True,
            output=format_kickoff_adjust_result(primitive="debate", note="三"),
            effect=ToolEffect.CONTINUE,
        )
    )
    debate.execute = AsyncMock()
    settled = await recover_turn(
        state=TurnState(
            plan=RunPlan(),
            completed={},
            execution_id="e1",
            coordination=None,
            entries=(),
        ),
        sink=EventSink(),
        delegate_tool=MagicMock(),
        debate_tool=debate,
        execution_id="e1",
        suspension=frame,
        decision=CheckpointDecision.ADJUST,
        note="三",
    )
    assert settled.effect is ToolEffect.CONTINUE
    assert settled.terminal_text is None
    assert "用户意见：三" in settled.output
    debate.resume_after_kickoff.assert_awaited_once()
    debate.execute.assert_not_called()
    assert debate.resume_after_kickoff.await_args.kwargs["decision"] is CheckpointDecision.ADJUST


@pytest.mark.asyncio
async def test_recover_three_delegate_adjusts_no_workers():
    """连续三轮 team_preview ADJUST：不 grant、不跑 worker、不升格终态。"""
    from agentcore.core.types import ToolEffect
    from agentcore.runtime.recover import recover_turn
    from agentcore.runtime.suspension import TeamPreviewSuspension
    from agentcore.runtime.turn.state import TurnState
    from tests.delegate.conftest import Provider, gate, resume_plan, tool

    prior = [
        {
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "tp0", "decision": "adjust", "note": "一"},
            "ts": "t0",
        },
        {
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "tp1", "decision": "adjust", "note": "二"},
            "ts": "t1",
        },
    ]
    plan = resume_plan()
    provider = Provider(["SHOULD_NOT_RUN"])
    approval = gate()
    t = tool(provider)
    t._approval_gate = approval
    frame = TeamPreviewSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="ck_tp",
        tool_call_id="call_del",
        user_message="组队",
        base_system_prompt="sys",
        journal_entries=prior,
        plan=plan,
        workers=[{"run_id": n.run_id, "role": n.role, "task": n.task} for n in plan.nodes],
        transcript=[],
    )
    settled = await recover_turn(
        state=TurnState(
            plan=plan,
            completed={},
            execution_id="e-adj-3",
            coordination=None,
            entries=(),
        ),
        sink=EventSink(),
        delegate_tool=t,
        execution_id="e-adj-3",
        suspension=frame,
        decision=CheckpointDecision.ADJUST,
        note="三",
    )
    assert settled.effect is ToolEffect.CONTINUE
    assert settled.terminal_text is None
    assert "用户意见：三" in settled.output
    assert "重新调用 delegate" in settled.output
    assert "宜先问" not in settled.output
    assert provider.calls == 0
    assert not approval.has_delegation_grant("e-adj-3")


def test_resume_adjust_requires_non_empty_note():
    """resume API：decision=adjust 必须带非空 note（与两端 UI 对齐）。"""
    from pydantic import ValidationError

    from agentcore.api.schemas.messages import ResumeTurnRequest

    with pytest.raises(ValidationError, match="非空意见"):
        ResumeTurnRequest(decision=CheckpointDecision.ADJUST, note="")
    with pytest.raises(ValidationError, match="非空意见"):
        ResumeTurnRequest(decision=CheckpointDecision.ADJUST, note="   ")
    ok = ResumeTurnRequest(decision=CheckpointDecision.ADJUST, note="人太多")
    assert ok.note == "人太多"
    # continue / stop 仍允许空 note（嘱咐 / 收场可选）。
    ResumeTurnRequest(decision=CheckpointDecision.CONTINUE, note="")
    ResumeTurnRequest(decision=CheckpointDecision.STOP, note="")


def _unfulfilled_adjust_facts(*, note: str = "人太多") -> list[dict]:
    return [
        {
            "kind": "team_preview_required",
            "payload": {"checkpoint_id": "tp1", "revision": 1},
            "ts": "t0",
        },
        {
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "tp1", "decision": "adjust", "note": note},
            "ts": "t1",
        },
    ]


def _fulfilled_adjust_facts(*, note: str = "人太多") -> list[dict]:
    return [
        *_unfulfilled_adjust_facts(note=note),
        {
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "tp2",
                "revision": 2,
                "revised_from": "tp1",
                "revision_note": note,
            },
            "ts": "t2",
        },
    ]


@pytest.mark.asyncio
async def test_drive_preview_seed_completed_still_hangs_on_unfulfilled_adjust(monkeypatch):
    """seed_completed 早退必须让位于未兑现 adjust（与 light 同缝）。"""
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes
    from agentcore.runtime.delegate import preview as preview_mod
    from agentcore.runtime.delegate.drive_preview import team_preview_before_workers
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from tests.delegate.conftest import Provider, tool

    await_calls = {"n": 0}

    async def _fake_await(*_a, **_k):
        await_calls["n"] += 1
        return CheckpointDecision.CONTINUE

    monkeypatch.setattr(preview_mod, "await_team_preview", _fake_await)
    monkeypatch.setattr(preview_mod, "should_kickoff", lambda *a, **k: True)
    monkeypatch.setattr(preview_mod, "needs_capability_auth", lambda *a, **k: False)

    real = tool(Provider([]))
    real._depth = 0
    real._pending_pause = False
    real._active_playbook = None
    real._permission_axes = recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT)

    plan = RunPlan(nodes=[RunSpec(run_id="a", agent_id="a", role="调研", task="t1")])
    token = current_fact_log.set(TurnFactLog(inherited_entries=_unfulfilled_adjust_facts()))
    try:
        result = await team_preview_before_workers(
            real,
            plan,
            complexity_hint="standard",
            seed_completed={"a": object()},
            call_idx=0,
        )
    finally:
        current_fact_log.reset(token)

    assert result is None
    assert await_calls["n"] == 1


@pytest.mark.asyncio
async def test_drive_preview_seed_completed_skips_when_adjust_fulfilled(monkeypatch):
    """新 required 已兑现 → seed_completed 仍跳卡，不重复强制挂卡。"""
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes
    from agentcore.runtime.delegate import preview as preview_mod
    from agentcore.runtime.delegate.drive_preview import team_preview_before_workers
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from tests.delegate.conftest import Provider, tool

    await_calls = {"n": 0}

    async def _fake_await(*_a, **_k):
        await_calls["n"] += 1
        return CheckpointDecision.CONTINUE

    monkeypatch.setattr(preview_mod, "await_team_preview", _fake_await)
    monkeypatch.setattr(preview_mod, "should_kickoff", lambda *a, **k: True)
    monkeypatch.setattr(preview_mod, "needs_capability_auth", lambda *a, **k: False)

    real = tool(Provider([]))
    real._depth = 0
    real._pending_pause = False
    real._active_playbook = None
    real._permission_axes = recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT)

    plan = RunPlan(nodes=[RunSpec(run_id="a", agent_id="a", role="调研", task="t1")])
    token = current_fact_log.set(TurnFactLog(inherited_entries=_fulfilled_adjust_facts()))
    try:
        result = await team_preview_before_workers(
            real,
            plan,
            complexity_hint="standard",
            seed_completed={"a": object()},
            call_idx=0,
        )
    finally:
        current_fact_log.reset(token)

    assert result is None
    assert await_calls["n"] == 0


@pytest.mark.asyncio
async def test_drive_preview_mlr_preauth_still_hangs_on_unfulfilled_adjust(monkeypatch):
    """should_kickoff 已判定挂卡后，未兑现 adjust 不得消费 MLR preauth 跳卡。"""
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes
    from agentcore.runtime.delegate import preview as preview_mod
    from agentcore.runtime.delegate.drive_preview import team_preview_before_workers
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from agentcore.runtime.kickoff.stage_card import (
        discard_mlr_preauth,
        grant_mlr_preauth,
        peek_mlr_preauth,
    )
    from tests.delegate.conftest import Provider, tool

    await_calls = {"n": 0}

    async def _fake_await(*_a, **_k):
        await_calls["n"] += 1
        return CheckpointDecision.CONTINUE

    monkeypatch.setattr(preview_mod, "await_team_preview", _fake_await)
    monkeypatch.setattr(preview_mod, "should_kickoff", lambda *a, **k: True)
    monkeypatch.setattr(preview_mod, "needs_capability_auth", lambda *a, **k: False)

    real = tool(Provider([]))
    real._depth = 0
    real._pending_pause = False
    real._active_playbook = "multi_lens_research"
    real._permission_axes = recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT)

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", agent_id="a", role="调研", task="t1"),
            RunSpec(run_id="b", agent_id="b", role="写手", task="t2"),
        ]
    )
    grant_mlr_preauth()
    token = current_fact_log.set(TurnFactLog(inherited_entries=_unfulfilled_adjust_facts()))
    try:
        result = await team_preview_before_workers(
            real,
            plan,
            complexity_hint="standard",
            seed_completed=None,
            call_idx=0,
        )
        assert result is None
        assert await_calls["n"] == 1
        assert peek_mlr_preauth() is True
    finally:
        current_fact_log.reset(token)
        discard_mlr_preauth()


@pytest.mark.asyncio
async def test_drive_preview_mlr_preauth_skips_when_adjust_fulfilled(monkeypatch):
    """新 required 已兑现 → MLR preauth 仍可一次性跳卡。"""
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes
    from agentcore.runtime.delegate import preview as preview_mod
    from agentcore.runtime.delegate.drive_preview import team_preview_before_workers
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from agentcore.runtime.kickoff.stage_card import (
        consume_mlr_preauth,
        discard_mlr_preauth,
        grant_mlr_preauth,
        peek_mlr_preauth,
    )
    from tests.delegate.conftest import Provider, tool

    await_calls = {"n": 0}

    async def _fake_await(*_a, **_k):
        await_calls["n"] += 1
        return CheckpointDecision.CONTINUE

    monkeypatch.setattr(preview_mod, "await_team_preview", _fake_await)
    monkeypatch.setattr(preview_mod, "should_kickoff", lambda *a, **k: True)
    monkeypatch.setattr(preview_mod, "needs_capability_auth", lambda *a, **k: False)

    real = tool(Provider([]))
    real._depth = 0
    real._pending_pause = False
    real._active_playbook = "multi_lens_research"
    real._permission_axes = recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT)

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", agent_id="a", role="调研", task="t1"),
            RunSpec(run_id="b", agent_id="b", role="写手", task="t2"),
        ]
    )
    grant_mlr_preauth()
    token = current_fact_log.set(TurnFactLog(inherited_entries=_fulfilled_adjust_facts()))
    try:
        result = await team_preview_before_workers(
            real,
            plan,
            complexity_hint="standard",
            seed_completed=None,
            call_idx=0,
        )
        assert result is None
        assert await_calls["n"] == 0
        assert peek_mlr_preauth() is False
        assert consume_mlr_preauth() is False
    finally:
        current_fact_log.reset(token)
        discard_mlr_preauth()
