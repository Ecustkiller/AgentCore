"""Leftover plan_review: extra checkpoint_after does not pause; resume_plan still drives tails."""

import pytest

from agentcore.core.types import ToolEffect
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.events import EventSink, EventType
from agentcore.runtime.interaction import InteractionRegistry
from agentcore.runtime.runs.types import RunPhase, RunState
from tests.delegate.conftest import (
    CKPT_DAG,
    Provider,
    ctx,
    resume_plan,
    tool,
    tool_durable,
)


async def test_checkpoint_after_extra_key_does_not_persist_or_pause():
    """多余键 checkpoint_after 不挂起、不 persist；两 worker 都跑完。"""
    registry = InteractionRegistry()
    sink = EventSink()
    saved: list = []
    dropped: list[str] = []

    async def _save(frame):
        saved.append(frame)

    async def _drop(mid):
        dropped.append(mid)

    t = tool_durable(Provider(["S1OUT", "S2OUT"]), sink, registry, _save, _drop)
    result = await t.execute({"tasks": CKPT_DAG, "coordinate": False}, ctx())

    assert result.effect is not ToolEffect.SUSPEND
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    assert saved == []
    assert dropped == []
    assert registry.list_pending("conv1") == []
    assert not any(str(e.type) == "plan_review_required" for e in sink._history)


async def test_failing_saver_not_invoked_when_checkpoint_after_ignored():
    """无 pause ⇒ saver 不会被调用；即使 saver 会炸，DAG 仍跑完。"""

    async def _save(_frame):
        raise RuntimeError("db down")

    async def _drop(_mid):
        pass

    registry = InteractionRegistry()
    t = tool_durable(Provider(["S1OUT", "S2OUT"]), EventSink(), registry, _save, _drop)
    result = await t.execute({"tasks": CKPT_DAG, "coordinate": False}, ctx())
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    assert registry.list_pending("conv1") == []


def test_leftover_plan_review_from_json_is_unknown_kind():
    """存量 kind=plan_review 帧：无 codec、from_json → ValueError。"""
    from agentcore.runtime.suspension import is_live_suspension_kind, suspension_from_json

    assert is_live_suspension_kind("plan_review") is False
    with pytest.raises(ValueError, match="unknown suspension kind"):
        suspension_from_json(
            {
                "kind": "plan_review",
                "message_id": "m1",
                "conversation_id": "conv1",
                "user_id": "u1",
                "captain_run_id": "CEO",
                "checkpoint_id": "ck1",
                "tool_call_id": "call_del",
                "base_system_prompt": "SYS",
                "user_message": "req",
            }
        )


async def test_resume_plan_continue_runs_only_the_tail():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    sink = EventSink()
    t = tool(provider, sink)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output
    assert "S2OUT" in result.output
    assert provider.calls == 1
    run_plans = [e for e in sink._history if e.type is EventType.RUN_PLAN]
    assert len(run_plans) == 1
    assert run_plans[0].payload["execution_id"] == "e"


async def test_resume_plan_stop_skips_the_tail():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["SHOULD_NOT_RUN"])
    t = tool(provider)
    result = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.STOP,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in result.output
    assert "SHOULD_NOT_RUN" not in result.output
    assert provider.calls == 0
    assert "写手" in result.output


async def test_resume_plan_adjust_steers_the_tail():
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
        execution_id="e",
    )
    assert "S2OUT" in result.output
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "把重点放在风险上" in s2_user


async def test_resume_plan_continue_llm_gate_notes_in_tail_prompt():
    """resume_plan CONTINUE + llm ceo_review → 下游 prompt 含 gate_notes（非 steer）。"""
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="这条备注不应进 steer",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
        ceo_review={
            "source": "llm",
            "conclusion": "规格可过",
            "risks": ["缺回滚预案"],
            "suggestions": ["先灰度"],
        },
    )
    s2 = plan.by_id(plan.nodes[1].run_id)
    assert "规格可过" in s2.gate_notes
    assert s2.steer == ""  # CONTINUE+note 不 apply_steer
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "规格可过" in (s2_user or "")
    assert "缺回滚预案" in (s2_user or "")
    assert "非否决" in (s2_user or "")
    assert "这条备注不应进 steer" not in (s2_user or "")


async def test_resume_plan_continue_deterministic_skips_gate_notes():
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
        ceo_review={
            "source": "deterministic",
            "conclusion": "回落摘要",
            "risks": ["x"],
            "suggestions": ["y"],
        },
    )
    assert plan.by_id(plan.nodes[1].run_id).gate_notes == ""
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "回落摘要" not in (s2_user or "")
    assert "用户已放行" not in (s2_user or "")


async def test_resume_plan_continue_with_note_without_kickoff_does_not_steer():
    """CONTINUE+note must not steer (UI still has a separate 调整)."""
    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["S2OUT"])
    t = tool(provider)
    await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.CONTINUE,
        note="不应注入",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    s2_user = next(
        m.content
        for req in provider.requests
        for m in req.messages
        if m.role == "user" and "撰写" in (m.content or "")
    )
    assert "不应注入" not in s2_user
    assert plan.by_id(plan.nodes[1].run_id).steer in (None, "")
