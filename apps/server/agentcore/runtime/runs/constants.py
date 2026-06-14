"""Run-model constants (统一 Run 模型 第一阶段).

Self-contained tunables for the ``runs`` package so it imports nothing outside
itself. The tree-wide concurrency budget lives here (not in a broad
``runtime.constants``) to keep ``runs`` a clean, dependency-light primitive.
"""

from __future__ import annotations

# Tree-wide cap on concurrently-running child runs across one turn's whole Run
# tree (the contextvar budget in ``concurrency.py`` enforces this across nested
# fan-outs). A wave's own width cap (WaveScheduler.max_parallel) is separate.
MAX_PARALLEL_DELEGATIONS = 6

# Most worker tasks one delegate call may spawn. Excess tasks are dropped.
MAX_DELEGATION_TASKS = 10

# Hard ceiling on per-node retries regardless of what a task declares.
MAX_RUN_RETRIES = 3

# Contract-gate retries are SEPARATE from the scheduler's failure retries
# (MAX_RUN_RETRIES): the latter re-runs on infra failure (crash/timeout), the
# former re-runs on *content* not meeting its contract, re-prompting with the
# specific shortfalls. Default 1 (one correction chance), hard-capped so a
# pathological contract can't loop a worker forever.
DEFAULT_CONTRACT_RETRIES = 1
MAX_CONTRACT_RETRIES = 3

# Default per-node failure strategy (see RunPolicy.on_failure).
DEFAULT_ON_FAILURE = "degrade"

# The accepted on_failure vocabulary the WaveScheduler enacts.
VALID_ON_FAILURE = frozenset({"abort", "skip", "degrade", "retry"})
