"""WaveScheduler — the concrete RunScheduler: dependency-wave execution.

The system's one scheduler. It owns *scheduling* control flow only —
ready-selection, the skip cascade, abort, the per-wave concurrency cap, per-node
retry, and accepting nodes appended mid-run — while *how* a node runs is the
injected :class:`RunExecutor`'s, and event emission / dependency-context assembly
stay the host's.

Each wave dispatches through :func:`gather_bounded`, which layers the tree-wide
concurrency budget on top of this scheduler's own wave-width cap so a node's
executor that fans out into a nested scheduler (阶段2) can't multiply past
``MAX_PARALLEL_DELEGATIONS``.

Failure strategy per node is :attr:`RunPolicy.on_failure` (retry → re-run then
degrade; skip → cascade-skip dependents; abort → stop scheduling; degrade →
dependents proceed).

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Mapping, Sequence

from agentcore.runtime.runs.concurrency import gather_bounded
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.scheduler import RunExecutor
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

# The most nodes one wave dispatches at once. Ready nodes beyond this stay
# pending and ride the next wave.
DEFAULT_MAX_PARALLEL = 6


class WaveScheduler:
    """Concrete :class:`RunScheduler` — drives a :class:`RunPlan` wave by wave to
    terminal."""

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

        Each iteration re-syncs the pending set from ``plan.nodes`` first, so a
        node appended mid-run (``RunPlan.add``) joins the next eligible wave. The
        loop ends when nothing is pending or a wave can make no progress.

        - ``seed_completed`` pre-seeds finished nodes (a resume): they are
          treated as done, so only the unfinished tail re-runs.
        - ``should_stop`` is checked *between* waves; True ends scheduling at a
          clean wave boundary and returns the partial map (a soft pause). An
          in-flight wave is never interrupted by it.
        - ``on_progress`` fires after every wave with the completed-so-far map, so
          the host can snapshot progress.
        - ``on_checkpoint`` (结构化挂起 2a) fires *after* a wave whose just-COMPLETED
          nodes include any with ``checkpoint_after`` set, and only while work
          remains downstream (``pending`` non-empty). It is awaited with those
          nodes + the completed-so-far map and returns whether to proceed; False
          ends scheduling like a graceful abort (partial map returned). The
          scheduler stays pure — the host's hook owns the user round-trip (emit a
          ``plan_review`` request, await the answer over the interaction bridge);
          a node whose ``checkpoint_after`` is unset, or any run with no hook
          injected, behaves exactly as before. A *failed* checkpoint node does not
          pause — its ``on_failure`` already governs the cascade.
        """
        completed: dict[str, RunState] = dict(seed_completed or {})
        skipped: set[str] = set()
        pending: set[str] = set()
        aborted = False

        while True:
            for node in plan.nodes:  # pick up mid-run appends
                if node.run_id not in completed and node.run_id not in skipped:
                    pending.add(node.run_id)
            if not pending or aborted:
                break
            if should_stop is not None and should_stop():
                break  # soft pause at a clean wave boundary

            ready = self._select_ready(plan, pending, completed, skipped)
            if not ready:
                break  # cascade left only skipped, or a cycle slipped through

            batch = ready[: self._max_parallel]
            wave_results = await self._run_wave(batch, executor, completed)
            for run_id, state in wave_results.items():
                completed[run_id] = state
                pending.discard(run_id)
                if state.phase is RunPhase.FAILED:
                    spec = plan.by_id(run_id)
                    on_failure = spec.policy.on_failure if spec else "degrade"
                    if on_failure == "abort":
                        aborted = True
                    elif on_failure == "skip":
                        self._propagate_skip(plan, run_id, pending, skipped)

            if on_progress is not None:
                on_progress(completed)

            # 结构化挂起 2a: pause after this wave when a just-COMPLETED node asked
            # for a checkpoint and downstream work remains. The host hook does the
            # user round-trip and returns whether to proceed; a stop ends scheduling
            # at this clean wave boundary (the unrun tail is left for the partial
            # map, same as abort). No hook / no marked node / no pending ⇒ untouched.
            if on_checkpoint is not None and pending:
                paused_nodes = [
                    spec
                    for spec in batch
                    if spec.checkpoint_after
                    and (st := wave_results.get(spec.run_id)) is not None
                    and st.phase is RunPhase.COMPLETED
                ]
                if paused_nodes and not await on_checkpoint(paused_nodes, completed):
                    aborted = True

        # Materialise the skip results for nodes the cascade dropped (never run).
        for run_id in skipped:
            completed.setdefault(run_id, RunState(phase=RunPhase.SKIPPED))
        # 结构化挂起 polish: a graceful abort (on_failure=abort, or a plan_review
        # stop via on_checkpoint) ends scheduling with an unrun tail. Materialise
        # that tail as SKIPPED — the same shape as a cascade skip — so the CEO
        # overview / graph shows "未执行" cleanly instead of a silently absent node.
        # (A soft should_stop pause is the resume substrate, not an abort, so its
        # tail is left out of ``completed`` to re-run on resume.)
        if aborted:
            for node in plan.nodes:
                completed.setdefault(node.run_id, RunState(phase=RunPhase.SKIPPED))
        return completed

    async def _run_wave(
        self,
        batch: list[RunSpec],
        executor: RunExecutor,
        completed: Mapping[str, RunState],
    ) -> dict[str, RunState]:
        """Run one wave's nodes concurrently; an executor exception becomes a
        ``FAILED`` state (cancellation re-raises so a pause is never swallowed).

        ``completed`` (the prior waves' terminal states) is passed to every node
        so an executor can read its ``depends_on`` outputs — all of a node's deps
        are terminal by the time its wave runs.

        Dispatch goes through ``gather_bounded`` so the tree-wide budget chunks
        this wave and hands each node a reduced child budget. Lazy factories
        (``lambda``) defer coroutine creation into each child's task context,
        required for the per-child budget ``set`` to stay isolated.
        """
        outcomes = await gather_bounded(
            [(lambda s=spec: self._run_node(s, executor, completed)) for spec in batch],
            return_exceptions=True,
        )
        results: dict[str, RunState] = {}
        for spec, outcome in zip(batch, outcomes, strict=True):
            if isinstance(outcome, asyncio.CancelledError):
                raise outcome
            if isinstance(outcome, BaseException):
                results[spec.run_id] = RunState(phase=RunPhase.FAILED, error=str(outcome))
            else:
                results[spec.run_id] = outcome
        return results

    async def _run_node(
        self,
        spec: RunSpec,
        executor: RunExecutor,
        completed: Mapping[str, RunState],
    ) -> RunState:
        """Run one node, retrying per its policy.

        ``retry`` re-runs up to ``max_retries`` (hard-capped at 3) with
        exponential backoff, returning the first completed state or the last
        failed one. Any other policy runs exactly once; the wave-level handling
        (skip / abort / degrade) acts on the returned ``FAILED`` state.
        """
        policy = spec.policy
        attempts = 1 + max(0, min(policy.max_retries, 3))
        last: RunState | None = None
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
        return last or RunState(phase=RunPhase.FAILED)

    def _select_ready(
        self,
        plan: RunPlan,
        pending: set[str],
        completed: dict[str, RunState],
        skipped: set[str],
    ) -> list[RunSpec]:
        """Pending nodes whose deps are all resolved.

        ``_deps_satisfied`` may add to ``skipped`` (the skip cascade). Order
        follows plan/declaration order (deterministic).
        """
        ready: list[RunSpec] = []
        for node in plan.nodes:
            if node.run_id in pending and self._deps_satisfied(
                plan, node, completed, skipped
            ):
                ready.append(node)
        return ready

    @staticmethod
    def _deps_satisfied(
        plan: RunPlan,
        spec: RunSpec,
        completed: dict[str, RunState],
        skipped: set[str],
    ) -> bool:
        """Whether ``spec`` may run: every dep resolved (completed/failed/skipped)
        and the node itself not (transitively) skipped.

        Skip cascade: when a dep that declared ``on_failure="skip"`` did not
        complete, record ``spec`` into ``skipped`` so the skip propagates, and
        report not-ready.
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
        pending: set[str],
        skipped: set[str],
    ) -> None:
        """Cascade-skip every pending dependent of ``failed_id`` (recursive)."""
        for spec in plan.nodes:
            if failed_id in spec.depends_on and spec.run_id in pending:
                skipped.add(spec.run_id)
                self._propagate_skip(plan, spec.run_id, pending, skipped)
