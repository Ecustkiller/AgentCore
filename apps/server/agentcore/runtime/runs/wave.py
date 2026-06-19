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

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence

from agentcore.runtime.runs.concurrency import child_budget, current_budget, set_budget
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

# The most nodes this scheduler runs at once. Ready nodes beyond this stay pending
# and ride a freed slot. Kept in step with MAX_PARALLEL_DELEGATIONS (the tree-wide
# budget) so neither alone re-bottlenecks a wide fan-out.
DEFAULT_MAX_PARALLEL = 8


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
        on_progress: Callable[[Mapping[str, RunState]], None] | None = None,
        on_checkpoint: (
            Callable[[Sequence[RunSpec], Mapping[str, RunState]], Awaitable[bool]] | None
        ) = None,
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
        - ``on_progress`` fires after *each* node finishes with the completed-so-far
          map, so the host gets smooth progress (one increment per node).
        - ``on_checkpoint`` (结构化挂起 2a) fires once in-flight work has *drained to a
          quiescent point* after a ``checkpoint_after`` node COMPLETED, while work
          still remains. Draining first keeps the persisted snapshot consistent so a
          2b resume re-runs exactly the un-run tail. It is awaited with the
          checkpoint node(s) + the completed map and returns whether to proceed;
          False ends scheduling like a graceful abort (partial map returned). A
          *failed* checkpoint node does not pause — its ``on_failure`` governs the
          cascade. No hook / no marked node / no pending ⇒ untouched.

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

        try:
            while True:
                # Freeze dispatch while aborting, soft-stopping, or holding a completed
                # checkpoint node whose review hasn't fired (we must quiesce in-flight
                # work before the pause so a 2b resume re-runs only the un-run tail).
                holding = aborted or stopped or bool(checkpoint_pending)
                if not holding and should_stop is not None and should_stop():
                    stopped = True  # soft pause: stop launching, drain in-flight
                    holding = True
                if not holding:
                    for spec in self._select_ready(plan, completed, skipped, dispatched):
                        if len(running) >= width:
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

                if not running:
                    break  # nothing in flight and (holding, or no node is ready) ⇒ done

                done, _ = await asyncio.wait(
                    set(running), return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    run_id = running.pop(task)
                    if task.cancelled():  # a pause/cancel must never be swallowed
                        raise asyncio.CancelledError
                    state = task.result()
                    completed[run_id] = state
                    if on_progress is not None:
                        on_progress(completed)
                    if state.phase is RunPhase.FAILED:
                        spec = plan.by_id(run_id)
                        on_failure = spec.policy.on_failure if spec else "degrade"
                        if on_failure == "abort":
                            aborted = True
                        elif on_failure == "skip":
                            self._propagate_skip(plan, run_id, skipped, dispatched)
                    elif state.phase is RunPhase.COMPLETED and on_checkpoint is not None:
                        # Track for the plan_review pause only when a hook is wired;
                        # without one the marker is fully inert (it must never freeze
                        # dispatch of the downstream it would have gated).
                        spec = plan.by_id(run_id)
                        if spec is not None and spec.checkpoint_after:
                            checkpoint_pending.append(spec)

                # 结构化挂起 2a: fire the plan_review only once in-flight work has fully
                # drained (quiescent) — so the snapshot the host persists is consistent
                # — and only while downstream work remains to gate.
                if on_checkpoint is not None and checkpoint_pending and not running:
                    nodes = checkpoint_pending
                    checkpoint_pending = []
                    pending_remains = any(
                        n.run_id not in completed and n.run_id not in skipped
                        for n in plan.nodes
                    )
                    if pending_remains and not await on_checkpoint(nodes, completed):
                        aborted = True
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
                state = await executor(spec, completed)
                state.attempt = attempt
                if state.phase is RunPhase.COMPLETED:
                    return state
                last = state
                if policy.on_failure != "retry":
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
    ) -> list[RunSpec]:
        """Not-yet-dispatched nodes whose deps are all resolved.

        ``_deps_satisfied`` may add to ``skipped`` (the skip cascade). Order follows
        plan/declaration order (deterministic).
        """
        ready: list[RunSpec] = []
        for node in plan.nodes:
            if node.run_id in dispatched or node.run_id in skipped:
                continue
            if self._deps_satisfied(plan, node, completed, skipped):
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
