"""开工卡取消：CEO tool result 软引导（不硬闸）。"""

from __future__ import annotations

import pytest

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.kickoff.cancel_guidance import (
    KICKOFF_CANCEL_GUIDANCE,
    format_kickoff_cancel_result,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState


def test_format_kickoff_cancel_result_delegate_and_debate():
    d = format_kickoff_cancel_result(primitive="delegate")
    assert "用户取消了开工，团队未启动。" in d
    assert KICKOFF_CANCEL_GUIDANCE in d
    assert "宜先问" in d and "再行动" in d

    b = format_kickoff_cancel_result(primitive="debate")
    assert "用户取消了辩论，未开赛。" in b
    assert KICKOFF_CANCEL_GUIDANCE in b

    with_note = format_kickoff_cancel_result(primitive="debate", note="  换个角度  ")
    assert "换个角度" in with_note
    assert KICKOFF_CANCEL_GUIDANCE in with_note
    assert "用户留言：" in with_note


@pytest.mark.asyncio
async def test_finalize_stopped_kickoff_cancelled_overrides_ceo_format():
    """开工取消覆写 format_for_ceo；空 seed 非 kickoff 不被误伤。"""
    from agentcore.runtime.delegate.supervised import finalize_stopped
    from tests.delegate.conftest import Provider, tool

    plan = RunPlan(
        nodes=[
            RunSpec(run_id="a", agent_id="a", role="调研", task="t1"),
            RunSpec(run_id="b", agent_id="b", role="写手", task="t2"),
        ]
    )
    t = tool(Provider([]))

    cancelled = await finalize_stopped(t, plan, {}, kickoff_cancelled=True)
    assert "宜先问" in cancelled.output
    assert "团队未启动" in cancelled.output
    assert "团队执行结果" not in cancelled.output

    # 空 seed 但非 kickoff（dispose / 误伤面）：仍走 format_for_ceo
    normal = await finalize_stopped(t, plan, {}, kickoff_cancelled=False)
    assert "宜先问" not in normal.output
    assert "团队执行结果" in normal.output


@pytest.mark.asyncio
async def test_resume_plan_stop_kickoff_vs_plan_review():
    """resume_plan STOP：仅 apply_kickoff_grant=True 换引导句。"""
    from tests.delegate.conftest import Provider, resume_plan, tool

    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["SHOULD_NOT_RUN"])
    t = tool(provider)

    # plan_review / 非 kickoff stop：保留 format_for_ceo（含已完成产出）
    review_stop = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.STOP,
        note="下游不要了",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
        apply_kickoff_grant=False,
    )
    assert "S1OUT" in review_stop.output
    assert "宜先问" not in review_stop.output
    assert provider.calls == 0

    # kickoff stop：覆写为引导（note 纳入）
    kickoff_stop = await t.resume_plan(
        plan,
        {},
        decision=CheckpointDecision.STOP,
        note="人太多",
        checkpoint_run_ids=set(),
        execution_id="e2",
        apply_kickoff_grant=True,
    )
    assert "宜先问" in kickoff_stop.output
    assert "人太多" in kickoff_stop.output
    assert "团队未启动" in kickoff_stop.output
    assert "团队执行结果" not in kickoff_stop.output
