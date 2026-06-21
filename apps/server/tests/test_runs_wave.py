"""Tests for WaveScheduler: ready-selection, dep-context handoff, the four
on_failure strategies (degrade / skip / abort / retry), exception capture, the
pause/resume substrate (seed_completed / should_stop / on_progress), and the
continuous-dispatch properties (downstream starts before a slow sibling; the
tree-wide budget isn't multiplied by nesting).

Uses a fake RunExecutor (a plain async callable) — no LLM, no engine — so the
scheduler's control flow is exercised in isolation.
"""

import asyncio

from agentcore.runtime.runs.concurrency import reset_budget, set_budget
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import BoundaryOutcome, BoundaryReason
from agentcore.runtime.runs.types import BatchMetrics, RunPhase, RunPolicy, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler


def _spec(
    run_id: str,
    deps: tuple[str, ...] = (),
    *,
    on_failure: str = "degrade",
    max_retries: int = 0,
    checkpoint_after: bool = False,
    bind_after_deps: bool = False,
) -> RunSpec:
    return RunSpec(
        run_id=run_id,
        task="t",
        agent_id=run_id,
        role=run_id,
        depends_on=list(deps),
        checkpoint_after=checkpoint_after,
        bind_after_deps=bind_after_deps,
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
    # The unrun tail materialises as SKIPPED (graceful abort), not absent.
    assert res["b"].phase is RunPhase.SKIPPED


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


async def test_on_progress_fires_after_each_node():
    # Continuous dispatch fires on_progress once per completed node (smoother than
    # the old per-wave cadence). A pipeline finishes a→b, so the snapshots grow by
    # one each time.
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


async def test_max_parallel_caps_concurrency():
    # 4 independent nodes, width 2 → never more than 2 run at once, but all finish.
    plan = RunPlan()
    for x in ("a", "b", "c", "d"):
        plan.add(_spec(x))
    state = {"active": 0, "peak": 0}

    async def ex(spec: RunSpec, _completed) -> RunState:
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        await asyncio.sleep(0.01)
        state["active"] -= 1
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    res = await WaveScheduler(max_parallel=2).run(plan, ex)
    assert set(res) == {"a", "b", "c", "d"}
    assert state["peak"] <= 2


async def test_continuous_dispatch_starts_downstream_before_slow_sibling():
    # a ∥ b independent; c depends only on a. b is slow. Continuous dispatch lets c
    # run the moment a finishes, instead of waiting for the whole「wave」(slow b) —
    # the latency win this scheduler exists for. (The old barrier scheduler would
    # finish b before c could start.)
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b"))
    plan.add(_spec("c", ("a",)))
    order: list[str] = []

    async def ex(spec: RunSpec, _completed) -> RunState:
        await asyncio.sleep(0.05 if spec.run_id == "b" else 0.005)
        order.append(spec.run_id)
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    res = await WaveScheduler().run(plan, ex)
    assert all(s.phase is RunPhase.COMPLETED for s in res.values())
    assert order.index("c") < order.index("b")


async def test_nested_fanout_respects_tree_budget():
    # An outer node whose executor itself runs a nested WaveScheduler must not let
    # the tree's concurrent leaf count exceed the budget (分而不乘): with budget 4,
    # the 4 outer nodes each get child budget 1, so each nested scheduler runs its
    # leaves serially → at most 4 leaves run at once, not 4 × 4.
    peak = {"active": 0, "max": 0}

    async def leaf(spec: RunSpec, _completed) -> RunState:
        peak["active"] += 1
        peak["max"] = max(peak["max"], peak["active"])
        await asyncio.sleep(0.01)
        peak["active"] -= 1
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    async def outer(spec: RunSpec, _completed) -> RunState:
        nested = RunPlan()
        for i in range(4):
            nested.add(_spec(f"{spec.run_id}{i}"))
        await WaveScheduler().run(nested, leaf)
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    plan = RunPlan()
    for x in ("p", "q", "r", "s"):
        plan.add(_spec(x))
    token = set_budget(4)
    try:
        res = await WaveScheduler().run(plan, outer)
    finally:
        reset_budget(token)
    assert all(s.phase is RunPhase.COMPLETED for s in res.values())
    assert peak["max"] <= 4


# --- 受监督的波循环: on_boundary CHECKPOINT arm (结构化挂起 2a) ------------------


async def test_on_checkpoint_fires_after_marked_node_with_downstream():
    # a (checkpoint_after) → b: the hook fires once after a's wave with reason
    # CHECKPOINT, seeing a as completed and a downstream node still pending; PROCEED
    # runs b.
    plan = RunPlan()
    plan.add(_spec("a", checkpoint_after=True))
    plan.add(_spec("b", ("a",)))
    seen: list[tuple] = []

    async def hook(reason, nodes, completed):
        seen.append((reason, [n.run_id for n in nodes], set(completed)))
        return BoundaryOutcome.PROCEED

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert seen == [(BoundaryReason.CHECKPOINT, ["a"], {"a"})]
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["b"].phase is RunPhase.COMPLETED


async def test_on_checkpoint_stop_halts_downstream():
    # ABORT ends scheduling at the wave boundary: a is kept, b never runs.
    plan = RunPlan()
    plan.add(_spec("a", checkpoint_after=True))
    plan.add(_spec("b", ("a",)))

    async def hook(_reason, _nodes, _completed):
        return BoundaryOutcome.ABORT

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert res["a"].phase is RunPhase.COMPLETED
    # The gated downstream is materialised as SKIPPED (clean graph/overview).
    assert res["b"].phase is RunPhase.SKIPPED


async def test_on_checkpoint_not_fired_on_last_wave():
    # A marked node with nothing downstream must NOT pause — no pending work to gate.
    plan = RunPlan()
    plan.add(_spec("a", checkpoint_after=True))
    calls = {"n": 0}

    async def hook(_reason, _nodes, _completed):
        calls["n"] += 1
        return BoundaryOutcome.PROCEED

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert calls["n"] == 0
    assert res["a"].phase is RunPhase.COMPLETED


async def test_on_checkpoint_skips_failed_marked_node():
    # A checkpoint node that FAILED does not pause — its on_failure governs instead.
    plan = RunPlan()
    plan.add(_spec("a", checkpoint_after=True, on_failure="degrade"))
    plan.add(_spec("b", ("a",)))
    calls = {"n": 0}

    async def ex(spec: RunSpec, _completed) -> RunState:
        if spec.run_id == "a":
            return RunState(phase=RunPhase.FAILED, error="boom")
        return RunState(phase=RunPhase.COMPLETED, content="b")

    async def hook(_reason, _nodes, _completed):
        calls["n"] += 1
        return BoundaryOutcome.PROCEED

    res = await WaveScheduler().run(plan, ex, on_boundary=hook)
    assert calls["n"] == 0
    assert res["a"].phase is RunPhase.FAILED
    assert res["b"].phase is RunPhase.COMPLETED  # degrade lets it proceed


async def test_checkpoint_after_inert_without_hook():
    # The marker is fully inert when no hook is injected (autonomous jobs / tests).
    plan = RunPlan()
    plan.add(_spec("a", checkpoint_after=True))
    plan.add(_spec("b", ("a",)))
    res = await WaveScheduler().run(plan, _ok)
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["b"].phase is RunPhase.COMPLETED


# --- 受监督的波循环: on_boundary BIND arm (晚绑定 / 职责晚绑定与动态再编排) ---------


async def test_bind_boundary_fires_then_proceeds_after_host_binds():
    # b is late-bound (bind_after_deps): once a completes and work is quiescent, the
    # boundary fires with reason=BIND for b (never dispatched unbound); the host
    # finalises it in place (clears the marker) and PROCEEDs, so b then runs.
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",), bind_after_deps=True))
    seen: list[tuple] = []

    async def hook(reason, nodes, completed):
        seen.append((reason, [n.run_id for n in nodes], set(completed)))
        for n in nodes:
            n.bind_after_deps = False  # host finalises the spec in place
        return BoundaryOutcome.PROCEED

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert seen == [(BoundaryReason.BIND, ["b"], {"a"})]
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["b"].phase is RunPhase.COMPLETED


async def test_bind_boundary_yield_soft_pauses_for_resume():
    # YIELD soft-pauses like should_stop: a is kept, the late-bound tail b is LEFT
    # OUT of the result (so a resume re-runs it), not materialised as SKIPPED.
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",), bind_after_deps=True))

    async def hook(_reason, _nodes, _completed):
        return BoundaryOutcome.YIELD

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert res["a"].phase is RunPhase.COMPLETED
    assert "b" not in res  # soft pause leaves the tail for a resume


async def test_bind_boundary_abort_materialises_skip():
    # ABORT ends scheduling gracefully: the un-run late-bound tail is materialised as
    # SKIPPED (same shape as a plan_review stop), not left absent.
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",), bind_after_deps=True))

    async def hook(_reason, _nodes, _completed):
        return BoundaryOutcome.ABORT

    res = await WaveScheduler().run(plan, _ok, on_boundary=hook)
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["b"].phase is RunPhase.SKIPPED


async def test_bind_after_deps_inert_without_hook():
    # No on_boundary hook (autonomous / tests): the marker is inert — the node
    # dispatches normally, exactly like checkpoint_after without a hook.
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",), bind_after_deps=True))
    res = await WaveScheduler().run(plan, _ok)
    assert res["a"].phase is RunPhase.COMPLETED
    assert res["b"].phase is RunPhase.COMPLETED


async def test_bind_boundary_not_fired_until_deps_resolve():
    # The bind boundary waits for the late-bound node's deps: while a is still running
    # it must not fire; it fires exactly once, after a lands (quiescent).
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",), bind_after_deps=True))
    fires = {"n": 0}

    async def slow_a(spec: RunSpec, _completed) -> RunState:
        if spec.run_id == "a":
            await asyncio.sleep(0.02)
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    async def hook(_reason, nodes, _completed):
        fires["n"] += 1
        for n in nodes:
            n.bind_after_deps = False
        return BoundaryOutcome.PROCEED

    res = await WaveScheduler().run(plan, slow_a, on_boundary=hook)
    assert fires["n"] == 1
    assert res["b"].phase is RunPhase.COMPLETED


# --- 调度埋点量化 (BatchMetrics) ---


async def _slow_ok(spec: RunSpec, _completed) -> RunState:
    await asyncio.sleep(0.02)
    return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)


async def test_metrics_sink_reports_batch_health():
    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(_spec(x))
    sink: list[BatchMetrics] = []
    await WaveScheduler().run(plan, _ok, metrics_sink=sink)
    assert len(sink) == 1
    m = sink[0]
    assert m.nodes == 3
    assert (m.completed, m.failed, m.skipped) == (3, 0, 0)
    assert m.peak_running >= 1
    assert m.slot_starved == 0  # default width (8) ≥ 3 → no starvation
    assert m.wall_ms >= 0 and m.busy_ms >= 0


async def test_metrics_not_appended_without_sink():
    # No sink → no metrics work surfaced (the scheduler return shape is unchanged).
    plan = RunPlan()
    plan.add(_spec("a"))
    res = await WaveScheduler().run(plan, _ok)
    assert res["a"].phase is RunPhase.COMPLETED


async def test_metrics_peak_running_reflects_parallelism():
    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(_spec(x))
    sink: list[BatchMetrics] = []
    await WaveScheduler(max_parallel=8).run(plan, _slow_ok, metrics_sink=sink)
    m = sink[0]
    assert m.peak_running == 3  # all three overlap under a wide cap
    assert m.slot_starved == 0


async def test_metrics_slot_starved_when_width_capped():
    plan = RunPlan()
    for x in ("a", "b", "c"):
        plan.add(_spec(x))
    sink: list[BatchMetrics] = []
    # width 1 → siblings can't all start; ready nodes starve on the cap.
    await WaveScheduler(max_parallel=1).run(plan, _slow_ok, metrics_sink=sink)
    m = sink[0]
    assert m.width == 1
    assert m.peak_running == 1
    assert m.slot_starved > 0
    assert m.completed == 3


async def test_metrics_excludes_seeded_nodes():
    plan = RunPlan()
    plan.add(_spec("a"))
    plan.add(_spec("b", ("a",)))
    seed = {"a": RunState(phase=RunPhase.COMPLETED, content="a")}
    sink: list[BatchMetrics] = []
    await WaveScheduler().run(plan, _ok, seed_completed=seed, metrics_sink=sink)
    m = sink[0]
    assert m.nodes == 1  # only b actually ran here
    assert m.completed == 1
