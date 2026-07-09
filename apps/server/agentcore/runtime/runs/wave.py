"""WaveScheduler — the concrete RunScheduler: continuous, dependency-driven execution.

The system's one scheduler. It owns *scheduling* control flow only —
ready-selection, the skip cascade, abort, the concurrency cap, per-node retry, and
accepting nodes appended mid-run — while *how* a node runs is the injected
:class:`RunExecutor`'s, and event emission / dependency-context assembly stay the
host's.

Dispatch is **continuous (event-driven)**, not wave-synchronous: a ready node is
launched the moment a slot frees, and a node becomes ready the moment *its own*
deps finish — it does NOT wait for the rest of its topological "wave". So a fast
node's dependents start while a slow *independent* sibling is still running, and a
freed concurrency slot is refilled immediately instead of idling until the whole
batch drains. (The legacy barrier scheduler held both back to the slowest node in
each wave — the latency this class exists to remove.)

Tree-wide concurrency stays bounded the same way (分而不乘): this scheduler runs at
most ``width`` nodes at once and hands each child a budget of ``budget // width``
(:func:`concurrency.child_budget`), so a node whose executor fans out into a nested
scheduler (阶段2) can't multiply past ``MAX_PARALLEL_DELEGATIONS``. Because waves
now *overlap*, the divisor is the fixed ``width`` (not a per-wave chunk size) — that
keeps the sum of concurrent child budgets ≤ the parent budget without a tree-shared
lock (the recursive-semaphore deadlock the ContextVar budget exists to avoid).

Failure strategy per node is :attr:`RunPolicy.on_failure` (retry → re-run then
degrade; skip → cascade-skip dependents; abort → drain in-flight then stop; degrade
→ dependents proceed).

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §八（Run 模型）
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Callable, Mapping
from dataclasses import replace

from agentcore.runtime.runs.concurrency import child_budget, current_budget, set_budget
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import (
    BoundaryOutcome,
    BoundaryReason,
    OnBoundary,
    RunExecutor,
)
from agentcore.runtime.runs.types import (
    BatchMetrics,
    NodeTiming,
    RunPhase,
    RunSpec,
    RunState,
)

# The most nodes this scheduler runs at once. Ready nodes beyond this stay pending
# and ride a freed slot. Kept in step with MAX_PARALLEL_DELEGATIONS (the tree-wide
# budget) so neither alone re-bottlenecks a wide fan-out.
DEFAULT_MAX_PARALLEL = 8


def _merge_retry_billing(prior: RunState, current: RunState) -> RunState:
    """Fold token/cost spend from earlier infra-retry attempts into the returned state.

    B-deep 失败计费 survives scheduler retries: a node that metered spend on attempt 1
    then fails again on attempt 2 must not drop attempt 1 from the final RunState the
    ledger and UI read.
    """
    if not prior.usage:
        return current
    merged_usage = dict(current.usage)
    for key, value in prior.usage.items():
        merged_usage[key] = merged_usage.get(key, 0) + value
    merged_cost = dict(current.cost)
    for key, value in prior.cost.items():
        if key == "currency":
            merged_cost.setdefault(key, value)
        else:
            merged_cost[key] = merged_cost.get(key, 0) + int(value)
    return replace(current, usage=merged_usage, cost=merged_cost)


class WaveScheduler:
    """Concrete :class:`RunScheduler` — drives a :class:`RunPlan` to terminal with
    continuous, dependency-driven dispatch."""

    def __init__(self, max_parallel: int = DEFAULT_MAX_PARALLEL) -> None:
        self._max_parallel = max(1, max_parallel)

    async def run(
        self,
        plan: RunPlan,
        executor: RunExecutor,
        *,
        seed_completed: Mapping[str, RunState] | None = None,
        should_stop: Callable[[], bool] | None = None,
        cancel_run_ids: Callable[[], frozenset[str]] | None = None,
        on_progress: Callable[[Mapping[str, RunState]], None] | None = None,
        on_boundary: OnBoundary | None = None,
        metrics_sink: list[BatchMetrics] | None = None,
    ) -> dict[str, RunState]:
        """Drive ``plan`` to completion; return each node's terminal
        :class:`RunState` by ``run_id`` (cascade-skipped nodes included).

        A node is dispatched as soon as (a) all its ``depends_on`` are terminal and
        (b) a concurrency slot is free; the loop then waits for the *next* node to
        finish and immediately re-evaluates — so dependents start the moment their
        own deps land and a freed slot is refilled right away. ``plan.nodes`` is
        re-scanned each cycle, so a node appended mid-run (``RunPlan.add``) joins as
        soon as it is eligible.

        - ``seed_completed`` pre-seeds finished nodes (a resume): they are treated as
          done, so only the unfinished tail re-runs.
        - ``should_stop`` is checked before each dispatch decision; once True no new
          node is launched, in-flight nodes are drained, and the partial map is
          returned (a soft pause — the un-run tail is left out so a resume re-runs
          it). An in-flight node is never interrupted by it.
        - ``cancel_run_ids`` is polled each cycle; run_ids in the returned set that
          are currently in-flight are cancelled individually — the cancelled node gets
          ``RunPhase.CANCELLED``, siblings keep running, and skip cascading does NOT
          propagate (unlike a failed ``on_failure="skip"`` node). Used by delegate
          drive for user-initiated worker redirect (Phase 2a).
        - ``on_progress`` fires after *each* node finishes with the completed-so-far
          map, so the host gets smooth progress (one increment per node).
        - ``on_boundary`` (受监督的波循环) is the host's decision-boundary hook, fired
          once in-flight work has *drained to a quiescent point* (draining first keeps
          the persisted snapshot consistent so a resume re-runs exactly the un-run
          tail). It is awaited with the :class:`BoundaryReason`, the triggering
          node(s), and the completed map, and returns a :class:`BoundaryOutcome`:
          ``PROCEED`` keeps scheduling, ``ABORT`` ends it like a graceful abort
          (un-run tail materialised SKIPPED), ``YIELD`` soft-pauses like
          ``should_stop`` (partial map, un-run tail LEFT OUT for a resume). Three
          reasons fire it:
          • ``CHECKPOINT`` (结构化挂起 2a) — a ``checkpoint_after`` node COMPLETED while
            downstream remains (the user plan_review). A *failed* checkpoint node does
            not pause — its ``on_failure`` governs the cascade.
          • ``BIND`` (晚绑定) — a ``bind_after_deps`` node's deps are all resolved but it
            is not yet finalised; it is never dispatched unbound, so it resolves only
            here (the CEO ``replan`` hand-back).
          • ``SCOPE`` (偏离信号 / 自底向上反应臂) — a COMPLETED node flagged a 职责/范围
            deviation (``escalate kind=scope``) while not-yet-run downstream remains; the
            CEO re-steers the un-run tail. Fires once per signal (surfacing marks it
            consumed), no live user needed (the reactive twin of ``BIND``).
          No hook ⇒ all markers inert (a ``bind_after_deps`` node then dispatches
          normally; a scope escalation just rides to synthesis); no marked node / no
          pending ⇒ untouched.
        - ``metrics_sink`` (调度埋点量化), when given, receives ONE :class:`BatchMetrics`
          appended at terminal — concurrency / parallelism / slot-starvation / outcome
          counts for this run — for the host to log. Kept as a sink (not a return /
          logging call) so the scheduler stays host-agnostic. Not appended on a cancel
          (the ``except`` re-raises first); a soft ``should_stop`` pause still records it.

        On external cancel (user stop) every in-flight child is cancelled and
        awaited before the cancellation propagates — a worker task is never orphaned.
        """
        completed: dict[str, RunState] = dict(seed_completed or {})
        skipped: set[str] = set()
        # Every run_id that has been launched (running, finished, or pre-seeded) so a
        # node is never dispatched twice across the continuous re-scan.
        dispatched: set[str] = set(completed)
        running: dict[asyncio.Task[RunState], str] = {}
        # checkpoint_after nodes that COMPLETED and whose plan_review hasn't fired.
        checkpoint_pending: list[RunSpec] = []
        aborted = False
        stopped = False

        # Fixed concurrency width + per-child budget for the whole run (waves overlap,
        # so the budget divisor can't be a per-wave chunk size). width ≤ the node
        # count keeps the common small batch's child budget == the legacy per-wave
        # ``budget // batch_size`` (e.g. a 3-worker batch → child budget 2, not 1).
        n_pending = sum(1 for n in plan.nodes if n.run_id not in completed)
        width = min(self._max_parallel, current_budget(), max(1, n_pending))
        per_child_budget = child_budget(width)

        # 晚绑定 (受监督的波循环): defer ``bind_after_deps`` nodes to the bind boundary
        # ONLY when a host hook can resolve them; with no hook the marker is inert and
        # such a node dispatches normally (parity with ``checkpoint_after``-without-hook).
        defer_bind = on_boundary is not None

        # 调度埋点量化 (orthogonal to scheduling — see BatchMetrics): wall start, per-node
        # dispatch times (→ busy_ms occupancy), the concurrency high-water mark, how many
        # nodes this run launched, and slot-starvation cycles (ready nodes blocked by width).
        seeded_ids = set(completed)
        wall_start = time.monotonic()
        started_at: dict[str, float] = {}
        busy_ms = 0
        peak_running = 0
        dispatched_count = 0
        slot_starved = 0
        # 多任务并行图 (并行时间线): each dispatched node's occupancy window as ms offsets from
        # wall_start — the same per-node dispatch/finish marks that feed busy_ms, kept (not
        # discarded) so the host can render real temporal parallelism. Dispatched nodes only.
        timeline: list[NodeTiming] = []
        # 受监督波循环埋点 (BatchMetrics §7.2): decision-boundary YIELDs fired this run, by
        # reason —晚绑定触发数 / 计划漂移返工触发数 / checkpoint. Counts fires (on_boundary
        # invocations), so a marked plan driven without a hook tallies zero.
        bind_boundaries = 0
        scope_boundaries = 0
        checkpoint_boundaries = 0
        cancelled_by_redirect: set[str] = set()

        try:
            while True:
                # Freeze dispatch while aborting, soft-stopping, or holding a completed
                # checkpoint node whose review hasn't fired (we must quiesce in-flight
                # work before the pause so a 2b resume re-runs only the un-run tail).
                holding = aborted or stopped or bool(checkpoint_pending)
                if not holding and should_stop is not None and should_stop():
                    stopped = True  # soft pause: stop launching, drain in-flight
                    holding = True
                # 晚绑定边界 (受监督的波循环): a ``bind_after_deps`` node whose deps are all
                # resolved is NOT dispatchable — its spec must first be finalised by the
                # host (CEO ``replan``). Once in-flight work is quiescent, yield the
                # boundary: PROCEED (host bound it in place → next ready-scan dispatches
                # it; if it bound nothing, no node is ready and the run reaches terminal,
                # no spin), YIELD (soft pause → CEO takes over, a resume re-runs the tail),
                # or ABORT. Inert unless a hook is wired AND such a node exists (none in an
                # ordinary plan), so a plan without late-binding is byte-for-byte untouched.
                if not holding and defer_bind and not running:
                    bind_ready = self._bind_pending(plan, completed, skipped, dispatched)
                    if bind_ready:
                        bind_boundaries += 1
                        outcome = await on_boundary(BoundaryReason.BIND, bind_ready, completed)
                        if outcome is BoundaryOutcome.ABORT:
                            aborted = True
                            holding = True
                        elif outcome is BoundaryOutcome.YIELD:
                            stopped = True
                            holding = True
                if not holding:
                    for spec in self._select_ready(
                        plan, completed, skipped, dispatched, defer_bind=defer_bind
                    ):
                        if len(running) >= width:
                            slot_starved += 1  # ready node(s) remain but width is full
                            break
                        # Snapshot the completed map per dispatch: the executor reads
                        # its deps + iterates peer products from it, and ``completed``
                        # is mutated as concurrent nodes finish — a live view would
                        # risk "dict changed size during iteration".
                        snapshot = dict(completed)
                        task = asyncio.create_task(
                            self._run_node(spec, executor, snapshot, per_child_budget)
                        )
                        running[task] = spec.run_id
                        dispatched.add(spec.run_id)
                        started_at[spec.run_id] = time.monotonic()
                        dispatched_count += 1
                    peak_running = max(peak_running, len(running))

                if not running:
                    break  # nothing in flight and (holding, or no node is ready) ⇒ done

                # Per-run user cancel (Phase 2a redirect): cancel specific in-flight tasks
                # without aborting the whole batch. Checked each cycle; a cancelled task
                # resolves on the next wait and is recorded as CANCELLED (not re-raised).
                if cancel_run_ids is not None and running:
                    for target_id in cancel_run_ids():
                        for task, rid in list(running.items()):
                            if rid == target_id and rid not in cancelled_by_redirect:
                                task.cancel()
                                cancelled_by_redirect.add(rid)

                done, _ = await asyncio.wait(
                    set(running),
                    timeout=0.05 if cancel_run_ids is not None else None,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if not done:
                    continue
                for task in done:
                    run_id = running.pop(task)
                    if run_id in cancelled_by_redirect:
                        # User-initiated single cancel: absorb gracefully, don't propagate
                        if not task.done():
                            task.cancel()
                        with contextlib.suppress(asyncio.CancelledError, Exception):
                            task.result()
                        state = RunState(phase=RunPhase.CANCELLED)
                    elif task.cancelled():
                        raise asyncio.CancelledError  # external cancel, propagate
                    else:
                        state = task.result()
                    completed[run_id] = state
                    started = started_at.pop(run_id, None)
                    if started is not None:  # node occupancy: dispatch → finish
                        finished = time.monotonic()
                        busy_ms += int((finished - started) * 1000)
                        timeline.append(
                            NodeTiming(
                                run_id=run_id,
                                start_ms=int((started - wall_start) * 1000),
                                end_ms=int((finished - wall_start) * 1000),
                                outcome=state.phase.value,
                            )
                        )
                    if on_progress is not None:
                        on_progress(completed)
                    if state.phase is RunPhase.FAILED:
                        spec = plan.by_id(run_id)
                        on_failure = spec.policy.on_failure if spec else "degrade"
                        if on_failure == "abort":
                            aborted = True
                        elif on_failure == "skip":
                            self._propagate_skip(plan, run_id, skipped, dispatched)
                    elif state.phase is RunPhase.COMPLETED and on_boundary is not None:
                        # Track for the plan_review pause only when a hook is wired;
                        # without one the marker is fully inert (it must never freeze
                        # dispatch of the downstream it would have gated).
                        spec = plan.by_id(run_id)
                        if spec is not None and spec.checkpoint_after:
                            checkpoint_pending.append(spec)

                # 结构化挂起 2a (CHECKPOINT boundary): fire the plan_review only once
                # in-flight work has fully drained (quiescent) — so the snapshot the host
                # persists is consistent — and only while downstream work remains to gate.
                if on_boundary is not None and checkpoint_pending and not running:
                    nodes = checkpoint_pending
                    checkpoint_pending = []
                    pending_remains = any(
                        n.run_id not in completed and n.run_id not in skipped for n in plan.nodes
                    )
                    if pending_remains:
                        checkpoint_boundaries += 1
                        outcome = await on_boundary(BoundaryReason.CHECKPOINT, nodes, completed)
                        if outcome is BoundaryOutcome.ABORT:
                            aborted = True
                        elif outcome is BoundaryOutcome.YIELD:
                            stopped = True

                # 反应臂边界 (受监督的波循环 SCOPE arm / 自底向上反应臂): a COMPLETED node
                # flagged a 职责/范围 deviation (escalate kind=scope) OR a 依赖缺口·卡在缺输入
                # (escalate kind=dep, §2.4 变·worker 的「拉」). Once in-flight work has drained
                # (quiescent) and not-yet-run downstream remains, yield to the CEO/lead — it reads
                # the signal + the node's output and re-steers (scope) / replan(add)s a producer
                # (dep) for the un-run tail. Each signal fires ONCE: surfacing it marks it consumed,
                # so a PROCEED can't spin and a YIELD's resume (which re-seeds the same completed
                # nodes) won't re-fire. Inert unless a hook is wired AND a scope/dep escalation
                # surfaced — an ordinary plan never enters here (零新增回合).
                if on_boundary is not None and not running and not aborted and not stopped:
                    scope_nodes = self._scope_pending(plan, completed)
                    if scope_nodes and any(
                        n.run_id not in completed and n.run_id not in skipped for n in plan.nodes
                    ):
                        scope_boundaries += 1
                        outcome = await on_boundary(BoundaryReason.SCOPE, scope_nodes, completed)
                        for node in scope_nodes:
                            state = completed.get(node.run_id)
                            if state is not None:
                                for e in state.escalations:
                                    if e.get("kind") in ("scope", "dep"):
                                        e["consumed"] = True
                        if outcome is BoundaryOutcome.ABORT:
                            aborted = True
                        elif outcome is BoundaryOutcome.YIELD:
                            stopped = True
        except BaseException:
            # External cancel (user stop via task.cancel) or an unexpected crash:
            # cancel every in-flight child and let it unwind (subprocess kill, salvage)
            # before propagating, so no worker task is left orphaned.
            for task in running:
                task.cancel()
            if running:
                await asyncio.gather(*running, return_exceptions=True)
            raise

        # Materialise cascade-skipped nodes (never ran) as SKIPPED.
        for run_id in skipped:
            completed.setdefault(run_id, RunState(phase=RunPhase.SKIPPED))
        # A graceful abort (on_failure=abort, or a plan_review stop) ends scheduling
        # with an un-run tail; materialise it as SKIPPED — the same shape as a cascade
        # skip — so the CEO overview / graph shows「未执行」cleanly instead of a silently
        # absent node. (A soft should_stop pause is the resume substrate, not an abort,
        # so its tail is left out of ``completed`` to re-run on resume.)
        if aborted:
            for node in plan.nodes:
                completed.setdefault(node.run_id, RunState(phase=RunPhase.SKIPPED))

        # 调度埋点量化: hand the host one snapshot of this run (counts exclude resume-seeded
        # nodes — they didn't run here). Appended only when a sink was given.
        if metrics_sink is not None:
            ran = [s for rid, s in completed.items() if rid not in seeded_ids]
            # escalate 信号占比 (raw → host derives scope/total): count over the nodes that
            # ran here, mirroring the outcome counts (seeded nodes' escalations belong to the
            # run that produced them, not this resumed slice).
            escalations = sum(len(s.escalations) for s in ran)
            scope_escalations = sum(
                1 for s in ran for e in s.escalations if e.get("kind") == "scope"
            )
            metrics_sink.append(
                BatchMetrics(
                    nodes=dispatched_count,
                    width=width,
                    peak_running=peak_running,
                    wall_ms=int((time.monotonic() - wall_start) * 1000),
                    busy_ms=busy_ms,
                    slot_starved=slot_starved,
                    completed=sum(1 for s in ran if s.phase is RunPhase.COMPLETED),
                    failed=sum(1 for s in ran if s.phase is RunPhase.FAILED),
                    skipped=sum(1 for s in ran if s.phase is RunPhase.SKIPPED),
                    cancelled=sum(1 for s in ran if s.phase is RunPhase.CANCELLED),
                    bind_boundaries=bind_boundaries,
                    scope_boundaries=scope_boundaries,
                    checkpoint_boundaries=checkpoint_boundaries,
                    escalations=escalations,
                    scope_escalations=scope_escalations,
                    timeline=timeline,
                )
            )
        return completed

    async def _run_node(
        self,
        spec: RunSpec,
        executor: RunExecutor,
        completed: Mapping[str, RunState],
        budget: int,
    ) -> RunState:
        """Run one node (with its retry policy) inside its own task context.

        Installs this child's reduced tree budget on the task-local context (no reset
        — the task's context copy is discarded when it ends) so a nested scheduler the
        executor may spawn divides from here, not from the root. ``retry`` re-runs up
        to ``max_retries`` (hard-capped at 3) with exponential backoff, returning the
        first completed state or the last failed one; any other policy runs exactly
        once. An executor crash is captured as a ``FAILED`` state (parity with the
        legacy ``gather(return_exceptions=True)``); a cancellation re-raises so the
        run-level cleanup can cancel siblings.
        """
        set_budget(budget)
        policy = spec.policy
        attempts = 1 + max(0, min(policy.max_retries, 3))
        last: RunState | None = None
        try:
            for attempt in range(attempts):
                if attempt > 0:
                    delay = policy.retry_delay_ms / 1000 * (2 ** (attempt - 1))
                    if delay > 0:
                        await asyncio.sleep(delay)
                    from agentcore.runtime.audit.hooks import on_run_retry

                    on_run_retry(
                        run_id=spec.run_id,
                        attempt=attempt,
                        source="on_failure",
                        error=str(last.error) if last and last.error else None,
                    )
                state = await executor(spec, completed)
                state.attempt = attempt
                if last is not None:
                    state = _merge_retry_billing(last, state)
                if state.phase is RunPhase.COMPLETED:
                    return state
                last = state
                if policy.on_failure != "retry":
                    break
                # 确定性失败区分 (BL-6): a FAILED run flagged non-retryable (prompt 超长 /
                # 鉴权 / 余额 — an AgentCoreError.retryable=False threaded onto the state)
                # will re-fail identically, so stop burning ``max_retries`` + tokens on a
                # known-futile re-run. Record it (后端补记) so the deterministic acceptance
                # is visible in the delegated-turn audit trail instead of silent.
                if state.phase is RunPhase.FAILED and not state.error_retryable:
                    from agentcore.runtime.audit.hooks import on_run_deterministic_failure

                    on_run_deterministic_failure(
                        run_id=spec.run_id,
                        error=str(state.error) if state.error else None,
                    )
                    break
        except asyncio.CancelledError:
            raise
        except BaseException as exc:  # noqa: BLE001 — an executor crash becomes FAILED
            return RunState(phase=RunPhase.FAILED, error=str(exc))
        return last or RunState(phase=RunPhase.FAILED)

    def _select_ready(
        self,
        plan: RunPlan,
        completed: Mapping[str, RunState],
        skipped: set[str],
        dispatched: set[str],
        *,
        defer_bind: bool = False,
    ) -> list[RunSpec]:
        """Not-yet-dispatched nodes whose deps are all resolved.

        ``_deps_satisfied`` may add to ``skipped`` (the skip cascade). Order follows
        plan/declaration order (deterministic). When ``defer_bind`` (a boundary hook is
        wired), ``bind_after_deps`` nodes are excluded — they are never dispatched
        unbound and resolve only via the bind boundary (:meth:`_bind_pending`); with no
        hook the marker is inert and such a node dispatches like any other.
        """
        ready: list[RunSpec] = []
        for node in plan.nodes:
            if node.run_id in dispatched or node.run_id in skipped:
                continue
            if defer_bind and node.bind_after_deps:
                continue
            if self._deps_satisfied(plan, node, completed, skipped):
                ready.append(node)
        return ready

    def _bind_pending(
        self,
        plan: RunPlan,
        completed: Mapping[str, RunState],
        skipped: set[str],
        dispatched: set[str],
    ) -> list[RunSpec]:
        """Late-bound (``bind_after_deps``) nodes whose deps are all resolved but which
        are not yet finalised — the host must bind / yield / abort before they run.

        Mirrors :meth:`_select_ready`'s gate for the un-dispatchable late-bound nodes it
        deliberately excludes, and shares :meth:`_deps_satisfied` (so the skip cascade
        still reaches a late-bound node whose upstream skip-failed). Empty for any plan
        with no ``bind_after_deps`` node, so the bind boundary stays inert there.
        """
        ready: list[RunSpec] = []
        for node in plan.nodes:
            if not node.bind_after_deps:
                continue
            if node.run_id in dispatched or node.run_id in skipped:
                continue
            if self._deps_satisfied(plan, node, completed, skipped):
                ready.append(node)
        return ready

    def _scope_pending(
        self,
        plan: RunPlan,
        completed: Mapping[str, RunState],
    ) -> list[RunSpec]:
        """COMPLETED nodes carrying an unconsumed reactive-boundary escalation — a 职责/范围
        deviation (``escalate kind=scope``) OR a 依赖缺口·卡在缺输入 (``escalate kind=dep``,
        §2.4) — the SCOPE boundary's triggers (自底向上反应臂). Both ride the SAME boundary:
        the CEO/lead re-steers (scope) or replan(add)s a producer (dep) for the un-run tail.
        A consumed signal (already surfaced at a prior boundary) is skipped, so each yields the
        host exactly once. Empty for any plan whose completed nodes raised no scope/dep
        escalation, so the boundary stays inert there.
        """
        ready: list[RunSpec] = []
        for node in plan.nodes:
            state = completed.get(node.run_id)
            if state is None or state.phase is not RunPhase.COMPLETED:
                continue
            if any(
                e.get("kind") in ("scope", "dep") and not e.get("consumed")
                for e in state.escalations
            ):
                ready.append(node)
        return ready

    @staticmethod
    def _deps_satisfied(
        plan: RunPlan,
        spec: RunSpec,
        completed: Mapping[str, RunState],
        skipped: set[str],
    ) -> bool:
        """Whether ``spec`` may run: every dep resolved (completed/failed/skipped)
        and the node itself not (transitively) skipped.

        Skip cascade: when a dep that declared ``on_failure="skip"`` did not
        complete, record ``spec`` into ``skipped`` so the skip propagates, and report
        not-ready.
        """
        for dep_id in spec.depends_on:
            if dep_id not in completed and dep_id not in skipped:
                return False
            dep = plan.by_id(dep_id)
            if dep and dep.policy.on_failure == "skip":
                dep_state = completed.get(dep_id)
                if dep_state and dep_state.phase is not RunPhase.COMPLETED:
                    skipped.add(spec.run_id)
                    return False
        return spec.run_id not in skipped

    def _propagate_skip(
        self,
        plan: RunPlan,
        failed_id: str,
        skipped: set[str],
        dispatched: set[str],
    ) -> None:
        """Cascade-skip every not-yet-dispatched dependent of ``failed_id`` (recursive).

        A dependent of a just-failed node can't already be dispatched (its dep only
        became terminal now), so this only ever marks un-launched nodes — the
        ``dispatched`` guard is belt-and-suspenders.
        """
        for spec in plan.nodes:
            if (
                failed_id in spec.depends_on
                and spec.run_id not in skipped
                and spec.run_id not in dispatched
            ):
                skipped.add(spec.run_id)
                self._propagate_skip(plan, spec.run_id, skipped, dispatched)
