"""Tests for the tree-wide concurrency budget primitives (ContextVar + child split).

The budget itself is *enforced* by the WaveScheduler (it divides by ``child_budget``
and caps concurrent dispatch); these cover the primitives in isolation. The
end-to-end「nested fan-out can't multiply past the budget」invariant for *raw*
WaveScheduler-in-WaveScheduler is in
test_runs_wave.py::test_nested_fanout_respects_tree_budget. Product nested
``delegate`` (depth≥1) reseeds full via ``reseed_nested_delegation_budget``.
"""

import asyncio

import pytest

from agentcore.runtime.runs.concurrency import (
    child_budget,
    current_budget,
    reseed_nested_delegation_budget,
    reset_budget,
    resolve_max_parallel,
    set_budget,
)
from agentcore.runtime.runs.constants import MAX_PARALLEL_DELEGATIONS
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState
from agentcore.runtime.runs.wave import WaveScheduler


def test_default_budget_is_the_tree_cap():
    assert current_budget() == MAX_PARALLEL_DELEGATIONS


def test_set_and_reset_budget_round_trips():
    token = set_budget(3)
    try:
        assert current_budget() == 3
    finally:
        reset_budget(token)
    assert current_budget() == MAX_PARALLEL_DELEGATIONS


def test_budget_floor_is_one():
    token = set_budget(0)
    try:
        assert current_budget() == 1
    finally:
        reset_budget(token)


def test_child_budget_divides_by_width():
    token = set_budget(8)
    try:
        assert child_budget(8) == 1
        assert child_budget(3) == 2  # 8 // 3
        assert child_budget(1) == 8
        assert child_budget(0) == 8  # width floored to 1
    finally:
        reset_budget(token)


def test_reseed_nested_delegation_budget_noop_at_root():
    token = set_budget(3)
    try:
        assert reseed_nested_delegation_budget(0) is None
        assert reseed_nested_delegation_budget(-1) is None
        assert current_budget() == 3
    finally:
        reset_budget(token)


def test_reseed_nested_delegation_budget_installs_full_knob():
    parent = set_budget(3)
    try:
        nested = reseed_nested_delegation_budget(1)
        assert nested is not None
        try:
            assert current_budget() == resolve_max_parallel()
        finally:
            reset_budget(nested)
        assert current_budget() == 3
    finally:
        reset_budget(parent)


@pytest.mark.asyncio
async def test_reseed_lets_nested_wave_run_full_fanout_under_parent_share():
    # Parent lead held share=3 (as after a 4-wide root divide of 12). Without
    # reseed a 4-node nest would peak at 3; with depth≥1 reseed all 4 run.
    peak = {"active": 0, "max": 0}

    async def leaf(spec: RunSpec, _completed) -> RunState:
        peak["active"] += 1
        peak["max"] = max(peak["max"], peak["active"])
        await asyncio.sleep(0.02)
        peak["active"] -= 1
        return RunState(phase=RunPhase.COMPLETED, content=spec.run_id)

    parent = set_budget(3)
    try:
        nested = reseed_nested_delegation_budget(1)
        assert nested is not None
        try:
            plan = RunPlan()
            for i in range(4):
                plan.add(
                    RunSpec(
                        run_id=f"n{i}",
                        task="t",
                        agent_id=f"n{i}",
                        role="w",
                    )
                )
            await WaveScheduler().run(plan, leaf)
        finally:
            reset_budget(nested)
    finally:
        reset_budget(parent)
    assert peak["max"] == 4
