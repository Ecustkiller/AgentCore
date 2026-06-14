"""Tests for the tree-wide concurrency budget (gather_bounded).

Order preservation and that a small budget actually caps concurrency (so a
nested fan-out can't multiply past the budget).
"""

import asyncio

from agentcore.runtime.runs.concurrency import gather_bounded, reset_budget, set_budget


async def test_preserves_order():
    async def mk(i: int) -> int:
        return i

    factories = [(lambda i=i: mk(i)) for i in range(5)]
    assert await gather_bounded(factories) == [0, 1, 2, 3, 4]


async def test_empty_is_noop():
    assert await gather_bounded([]) == []


async def test_small_budget_caps_concurrency():
    state = {"active": 0, "peak": 0}

    async def job() -> int:
        state["active"] += 1
        state["peak"] = max(state["peak"], state["active"])
        await asyncio.sleep(0.01)
        state["active"] -= 1
        return 0

    token = set_budget(2)
    try:
        await gather_bounded([(lambda: job()) for _ in range(6)])
    finally:
        reset_budget(token)
    assert state["peak"] <= 2


async def test_return_exceptions_surfaces_failures():
    async def boom() -> int:
        raise ValueError("x")

    async def ok() -> int:
        return 1

    out = await gather_bounded([(lambda: ok()), (lambda: boom())], return_exceptions=True)
    assert out[0] == 1
    assert isinstance(out[1], ValueError)
