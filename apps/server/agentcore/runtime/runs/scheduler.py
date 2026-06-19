"""RunScheduler — the one scheduler that drives a RunPlan to completion.

A scheduler advances a plan by dependency order — launching each node the moment
its ``depends_on`` are terminal and a concurrency slot is free (continuous, not
wave-synchronous) — runs nodes concurrently through an injected
:class:`RunExecutor`, and accepts nodes appended mid-run (阶段2 captain
``delegate``). Isolating the interface keeps ``runs`` free of any host import — the
executor (*how* a node runs) is the host's concern, not the scheduler's (which only
owns *when*).

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（Run 模型）
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Protocol, runtime_checkable

from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunSpec, RunState

# Runs one node to terminal and returns its final state. The host injects this:
# it builds the worker's messages and runs the ReAct loop (阶段1), or — 阶段2 —
# spawns a child engine / folds a synthesis. The scheduler stays ignorant of
# *how* a node runs, only *when* (its wave).
#
# The second argument is the terminal states of every node finished so far, keyed
# by ``run_id``; an executor reads its node's ``depends_on`` entries from it to
# inject upstream products (the DAG dep-context). A node with no deps ignores it.
RunExecutor = Callable[[RunSpec, Mapping[str, RunState]], Awaitable[RunState]]


@runtime_checkable
class RunScheduler(Protocol):
    """The system's single scheduler."""

    async def run(self, plan: RunPlan, executor: RunExecutor) -> dict[str, RunState]:
        """Drive ``plan`` to completion; return each node's terminal
        :class:`RunState` keyed by ``run_id``.

        Dispatch order honours ``depends_on`` (a node runs only once its deps are
        terminal); per-node failure handling follows the node's :class:`RunPolicy`
        (``on_failure``), so a failed dependency can fail / skip / retry its
        dependents without the caller branching.
        """
        ...
