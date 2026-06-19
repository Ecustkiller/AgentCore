"""Tree-wide run concurrency budget.

Bounds the *total* number of concurrently-running child runs across a whole Run
tree, enforcing ``MAX_PARALLEL_DELEGATIONS`` — the cap a single scheduler's own
width does *not* enforce across nesting.

Why this matters: :class:`WaveScheduler` caps how many nodes *it* runs at once, but
a node's executor can (阶段2) spawn a child engine that itself fans out into a
*nested* scheduler. Without a tree-wide budget those caps multiply — depth 3 ×
fan-out 6 explodes to ``6 + 36 + 216`` concurrent runs, each holding a DB session
and firing its own LLM call. The budget rides an async-context :class:`ContextVar`:
each scheduler divides its budget by the number of nodes it runs concurrently
(:func:`child_budget`) and installs the reduced share on each child run's task
context, so nested fan-outs *divide* rather than *multiply* — with no shared lock
held across recursion, so the classic recursive-semaphore deadlock can't happen.
"""

from __future__ import annotations

import contextvars

from agentcore.runtime.runs.constants import MAX_PARALLEL_DELEGATIONS

_budget: contextvars.ContextVar[int] = contextvars.ContextVar(
    "run_parallel_budget", default=MAX_PARALLEL_DELEGATIONS
)


def current_budget() -> int:
    """Remaining parallel slots available to the current subtree (always >= 1)."""
    return max(1, _budget.get())


def set_budget(value: int) -> contextvars.Token[int]:
    """Set the parallel budget for the current context; returns a reset token.

    Seeds the root budget at a tree entry point (and by tests), and is called inside
    each child run's task to install its reduced share — no reset needed there, the
    task's context copy is discarded when it ends.
    """
    return _budget.set(max(1, value))


def reset_budget(token: contextvars.Token[int]) -> None:
    """Restore a budget previously set via :func:`set_budget`."""
    _budget.reset(token)


def child_budget(width: int) -> int:
    """The per-child budget when this subtree runs ``width`` nodes concurrently.

    Integer-dividing the current budget by the concurrency width keeps the sum of
    the concurrent children's budgets ≤ this subtree's budget, so the product across
    depth can't explode. Always ≥ 1 (a single slot still makes progress).
    """
    return max(1, current_budget() // max(1, width))
