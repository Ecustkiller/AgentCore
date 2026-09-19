"""resume_plan STOP：保留 format_for_ceo。"""

from __future__ import annotations

import pytest

from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.runs.types import RunPhase, RunState


@pytest.mark.asyncio
async def test_resume_plan_stop_keeps_ceo_format():
    from tests.delegate.conftest import Provider, resume_plan, tool

    plan = resume_plan()
    seed = {plan.nodes[0].run_id: RunState(phase=RunPhase.COMPLETED, content="S1OUT")}
    provider = Provider(["SHOULD_NOT_RUN"])
    t = tool(provider)

    review_stop = await t.resume_plan(
        plan,
        seed,
        decision=CheckpointDecision.STOP,
        note="下游不要了",
        checkpoint_run_ids={plan.nodes[0].run_id},
        execution_id="e",
    )
    assert "S1OUT" in review_stop.output
    assert "宜先问" not in review_stop.output
    assert provider.calls == 0
