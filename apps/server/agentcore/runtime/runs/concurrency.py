"""Tree-wide run concurrency budget.

Bounds the *total* number of concurrently-running child runs across a whole Run
tree, enforcing ``MAX_PARALLEL_DELEGATIONS`` — the cap the wave scheduler's own
per-wave width does *not* enforce across nesting.

Why this matters: ``WaveScheduler`` caps how many nodes one wave dispatches, but
a node's executor can (阶段2) spawn a child engine that itself fans out into a
*nested* ``WaveScheduler``. Without a tree-wide budget those caps multiply —
depth 3 × fan-out 6 explodes to ``6 + 36 + 216`` concurrent runs, each holding a
DB session and firing its own LLM call. The budget rides an async-context
``ContextVar`` and is split per child at each fan-out, so nested fan-outs
*divide* rather than *multiply*, with no shared lock held across recursion (so
the classic recursive-semaphore deadlock can't happen).

At the tree root, when the budget ≥ the number of tasks (the common non-nested
case), everything runs in a single chunk — identical to a plain ``asyncio.gather``.
"""

from __future__ import annotations

import asyncio
import contextvars
from collections.abc import Awaitable, Callable, Sequence
from typing import cast

from agentcore.runtime.runs.constants import MAX_PARALLEL_DELEGATIONS

_budget: contextvars.ContextVar[int] = contextvars.ContextVar(
    "run_parallel_budget", default=MAX_PARALLEL_DELEGATIONS
)


def current_budget() -> int:
    """Remaining parallel slots available to the current subtree (always >= 1)."""
    return max(1, _budget.get())


def set_budget(value: int) -> contextvars.Token[int]:
    """Set the parallel budget for the current context; returns a reset token.

    Used to seed the root budget at a tree entry point and by tests. Nested
    fan-outs do not call this directly — they go through :func:`gather_bounded`,
    which assigns each child its own reduced budget.
    """
    return _budget.set(max(1, value))


def reset_budget(token: contextvars.Token[int]) -> None:
    """Restore a budget previously set via :func:`set_budget`."""
    _budget.reset(token)


def _child_budget(chunk_size: int) -> int:
    """Budget handed to each child so the subtree total stays bounded.

    Integer-dividing the current budget by how many children run at once keeps
    the product across depth from exploding.
    """
    return max(1, current_budget() // max(1, chunk_size))


async def gather_bounded[T](
    factories: Sequence[Callable[[], Awaitable[T]]],
    *,
    return_exceptions: bool = False,
) -> list[T]:
    """Run *factories* concurrently, bounded by the current run budget.

    Order-preserving. Splits the work into chunks of ``min(len, budget)`` and
    awaits each chunk via :func:`asyncio.gather`; every factory runs with a
    reduced child budget so nested fan-outs stay bounded tree-wide.

    ``factories`` are zero-arg callables (not bare awaitables) so each coroutine
    is created lazily inside its own task context — required for the per-child
    budget ``set`` to stay isolated to that child's subtree.

    When ``budget >= len(factories)`` (the typical top-level fan-out) this runs
    everything in one chunk, behaving exactly like a plain ``asyncio.gather``.
    """
    if not factories:
        return []

    chunk_size = min(len(factories), current_budget())
    child = _child_budget(chunk_size)

    async def _run(factory: Callable[[], Awaitable[T]]) -> T:
        # Runs inside this gather task's own context copy, so the reduced budget
        # is visible to everything this child awaits (including deeper nested
        # schedulers) without leaking to siblings or the parent.
        _budget.set(child)
        return await factory()

    results: list[T] = []
    for start in range(0, len(factories), chunk_size):
        chunk = factories[start : start + chunk_size]
        chunk_results = await asyncio.gather(
            *(_run(f) for f in chunk),
            return_exceptions=return_exceptions,
        )
        results.extend(cast("list[T]", chunk_results))
    return results
