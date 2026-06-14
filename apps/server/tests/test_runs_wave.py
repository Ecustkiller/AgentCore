"""Tests for WaveScheduler: ready-selection, dep-context handoff, the four
on_failure strategies (degrade / skip / abort / retry), exception capture, and
the pause/resume substrate (seed_completed / should_stop / on_progress).

Uses a fake RunExecutor (a plain async callable) — no LLM, no engine — so the
scheduler's control flow is exercised in isolation.
"""

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunPolicy, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler


def _spec(
    run_id: str,
    deps: tuple[str, ...] = (),
    *,
    on_failure: str = "degrade",
    max_retries: int = 0,
) -> RunSpec:
    return RunSpec(
        run_id=run_id,
        task="t",
        agent_id=run_id,
        role=run_id,
        depends_on=list(deps),
        policy=RunPolicy(on_failure=on_failure, max_retries=max_retries),
    )


async def _ok(spec: RunSpec, _completed) -> RunState:
    return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)


async def test_parallel_all_complete():
    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(_spec(x))
    res = await WaveScheduler().run(plan, _ok)
    assert set(res) == {"a", "b", "c"}
    assert all(s.phase is RunPhase.COMPLETED for s in res.values())


async def test_dag_runs_in_order_and_sees_completed_deps():
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",)))
    seen: dict[str, set[str]] = {}

    async def ex(spec: RunSpec, completed) -> RunState:
        seen[spec.run_id] = set(completed)
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    await WaveScheduler().run(plan, ex)
    assert seen["a"] == set()
    assert "a" in seen["b"]


async def test_skip_cascades_to_dependents():
    plan = RunPlan()
    plan.add(_spec("a", on_failure="skip"))
    plan.add(_spec("b", ("a",)))

    async def ex(spec: RunSpec, _completed) -> RunState:
        if spec.run_id == "a":
            return RunState(phase=RunPhase.FAILED, error="boom")
        return RunState(phase=RunPhase.COMPLETED, content="b")

    res = await WaveScheduler().run(plan, ex)
    assert res["a"].phase is RunPhase.FAILED
    assert res["b"].phase is RunPhase.SKIPPED


async def test_abort_stops_later_waves():
    plan = RunPlan()
    plan.add(_spec("a", on_failure="abort"))
    plan.add(_spec("b", ("a",)))

    async def ex(spec: RunSpec, _completed) -> RunState:
        if spec.run_id == "a":
            return RunState(phase=RunPhase.FAILED, error="boom")
        return RunState(phase=RunPhase.COMPLETED, content="b")

    res = await WaveScheduler().run(plan, ex)
    assert res["a"].phase is RunPhase.FAILED
    assert "b" not in res


async def test_degrade_lets_dependents_proceed():
    plan = RunPlan()
    plan.add(_spec("a", on_failure="degrade"))
    plan.add(_spec("b", ("a",)))

    async def ex(spec: RunSpec, _completed) -> RunState:
        if spec.run_id == "a":
            return RunState(phase=RunPhase.FAILED, error="boom")
        return RunState(phase=RunPhase.COMPLETED, content="b")

    res = await WaveScheduler().run(plan, ex)
    assert res["a"].phase is RunPhase.FAILED
    assert res["b"].phase is RunPhase.COMPLETED


async def test_retry_then_succeeds():
    plan = RunPlan()
    plan.add(_spec("a", on_failure="retry", max_retries=2))
    calls = {"n": 0}

    async def ex(_spec: RunSpec, _completed) -> RunState:
        calls["n"] += 1
        if calls["n"] < 2:
            return RunState(phase=RunPhase.FAILED, error="transient")
        return RunState(phase=RunPhase.COMPLETED, content="ok")

    res = await WaveScheduler().run(plan, ex)
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["a"].attempt == 1
    assert calls["n"] == 2


async def test_executor_exception_becomes_failed_state():
    plan = RunPlan()
    plan.add(_spec("a"))

    async def ex(_spec: RunSpec, _completed) -> RunState:
        raise RuntimeError("kaboom")

    res = await WaveScheduler().run(plan, ex)
    assert res["a"].phase is RunPhase.FAILED
    assert "kaboom" in res["a"].error


async def test_on_progress_fires_after_each_wave():
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",)))
    snaps: list[set[str]] = []
    await WaveScheduler().run(plan, _ok, on_progress=lambda c: snaps.append(set(c)))
    assert snaps == [{"a"}, {"a", "b"}]


async def test_seed_completed_skips_finished_nodes():
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",)))
    ran: list[str] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        ran.append(spec.run_id)
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    seed = {"a": RunState(phase=RunPhase.COMPLETED, content="cached")}
    res = await WaveScheduler().run(plan, ex, seed_completed=seed)
    assert ran == ["b"]
    assert res["a"].content == "cached"


async def test_should_stop_pauses_between_waves():
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",)))
    res = await WaveScheduler().run(plan, _ok, should_stop=lambda: True)
    assert res == {}


async def test_max_parallel_caps_wave_width():
    plan = RunPlan()
    for x in ("a", "b", "c", "d"):
        plan.add(_spec(x))
    waves_seen: list[int] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    await WaveScheduler(max_parallel=2).run(
        plan, ex, on_progress=lambda c: waves_seen.append(len(c))
    )
    # 4 independent nodes, width 2 → two waves of 2 (cumulative 2 then 4).
    assert waves_seen == [2, 4]
