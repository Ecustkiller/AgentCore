"""Turn wall-clock budget: a stuck worker must still produce a terminal map.

A partial, honestly annotated answer beats a green collaboration graph that
never closes. These tests exercise the scheduler in isolation (no LLM / PG).
"""

import asyncio
import time

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunPolicy, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler


def _spec(run_id: str, deps: tuple[str, ...] = ()) -> RunSpec:
    return RunSpec(
        run_id=run_id,
        task="t",
        agent_id=run_id,
        role=run_id,
        depends_on=list(deps),
        policy=RunPolicy(on_failure="degrade"),
    )


async def test_deadline_cancels_inflight_and_closes_unrun_tail():
    plan = RunPlan()
    plan.add(_spec("slow"))
    plan.add(_spec("blocked", ("slow",)))

    async def stuck(_spec: RunSpec, _completed) -> RunState:
        await asyncio.Event().wait()
        return RunState(phase=RunPhase.COMPLETED, content=_spec.run_id)

    skipped: list[str] = []
    res = await WaveScheduler().run(
        plan,
        stuck,
        deadline_mono=time.monotonic() + 0.05,
        on_skipped=lambda rid, _aid, _reason: skipped.append(rid),
    )

    # A complete terminal map is what lets the CEO roster name every unfinished
    # worker — no plan node may be left silently pending.
    assert set(res) == {"slow", "blocked"}
    assert res["slow"].phase is RunPhase.CANCELLED
    assert res["blocked"].phase is RunPhase.SKIPPED
    assert "blocked" in skipped
    assert not any(s.phase is RunPhase.COMPLETED for s in res.values())


async def test_deadline_not_reached_does_not_cancel():
    plan = RunPlan()
    plan.add(_spec("a"))

    async def quick(spec: RunSpec, _completed) -> RunState:
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    res = await WaveScheduler().run(
        plan, quick, deadline_mono=time.monotonic() + 60.0
    )
    assert res["a"].phase is RunPhase.COMPLETED


async def test_no_deadline_keeps_legacy_behaviour():
    plan = RunPlan()
    plan.add(_spec("a"))

    async def quick(spec: RunSpec, _completed) -> RunState:
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    res = await WaveScheduler().run(plan, quick)
    assert res["a"].phase is RunPhase.COMPLETED
