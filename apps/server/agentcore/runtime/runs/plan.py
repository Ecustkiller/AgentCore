"""RunPlan — a turn's set of Run nodes + their dependency wave order.

Every orchestration shape is a *degenerate* RunPlan, so the scheduler has one
input shape and single / parallel / DAG become data, not code paths:

- single worker     = one node, no deps;
- parallel batch    = N independent nodes;
- DAG               = nodes wired by ``depends_on``;
- adaptive (阶段2)  = an empty plan a captain grows via :meth:`add`.

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

from dataclasses import dataclass, field

from agentcore.runtime.runs.types import RunOrigin, RunSpec


class RunPlanError(ValueError):
    """A plan can't be scheduled: a duplicate ``run_id``, an unknown
    ``depends_on`` edge, or a dependency cycle."""


@dataclass
class RunPlan:
    """An ordered bag of :class:`RunSpec` nodes plus where they came from.

    Mutable on purpose: a captain may append nodes mid-run (``origin =
    CAPTAIN``, 阶段2). The plan owns only structure (nodes + edges); execution
    state lives in each node's :class:`RunState`, driven by the scheduler.
    """

    nodes: list[RunSpec] = field(default_factory=list)
    origin: RunOrigin = RunOrigin.TEMPLATE

    def add(self, spec: RunSpec) -> RunSpec:
        """Append one node. A duplicate ``run_id`` is a caller bug (ids are
        minted by the caller) and raises rather than silently shadowing."""
        if any(n.run_id == spec.run_id for n in self.nodes):
            raise RunPlanError(f"duplicate run_id: {spec.run_id}")
        self.nodes.append(spec)
        return spec

    def by_id(self, run_id: str) -> RunSpec | None:
        return next((n for n in self.nodes if n.run_id == run_id), None)

    def waves(self) -> list[list[RunSpec]]:
        """Group nodes into dependency waves (Kahn-style topological layering).

        Wave 0 = nodes with no unmet deps; each later wave = nodes whose deps all
        landed in an earlier wave. Node order *within* a wave preserves insertion
        order, so a plan with no deps reproduces declaration order.

        Raises :class:`RunPlanError` on an unknown edge (a ``depends_on`` naming a
        run not in the plan) or a cycle (nodes remain but none can advance).
        """
        ids = {n.run_id for n in self.nodes}
        for n in self.nodes:
            for dep in n.depends_on:
                if dep not in ids:
                    raise RunPlanError(f"run {n.run_id} depends on unknown run {dep}")

        resolved: set[str] = set()
        waves: list[list[RunSpec]] = []
        remaining = list(self.nodes)
        while remaining:
            wave = [n for n in remaining if all(d in resolved for d in n.depends_on)]
            if not wave:
                stuck = ", ".join(n.run_id for n in remaining)
                raise RunPlanError(f"dependency cycle among runs: {stuck}")
            waves.append(wave)
            resolved.update(n.run_id for n in wave)
            remaining = [n for n in remaining if n.run_id not in resolved]
        return waves
