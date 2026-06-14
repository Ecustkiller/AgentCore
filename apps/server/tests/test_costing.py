"""Unit tests for the per-run cost ledger builders (runtime/costing.py).

Pure and DB-free: they pin how a finished run becomes a ``cost_events`` row.
A delegated member reads the price the executor already stamped onto its
``RunState`` (it is never re-priced); the captain root — the pipeline's own ReAct
loop, which has no scheduled RunState — is priced exactly once here via the single
:func:`calculate_cost`. Money is integer nano-USD throughout.
"""

from dataclasses import asdict

from agentcore.llm.config import DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO
from agentcore.llm.pricing import calculate_cost
from agentcore.llm.protocol import TokenUsage
from agentcore.runtime.costing import (
    ROLE_CAPTAIN,
    ROLE_MEMBER,
    aggregate_cost,
    captain_run_cost,
    member_run_cost,
)
from agentcore.runtime.runs.types import RunSpec, RunState


def test_member_run_cost_reads_state_without_repricing():
    # The executor already priced this run onto state.cost; the builder must read
    # it verbatim (a member is never re-priced) and parent it to the captain.
    spec = RunSpec(run_id="run-1", task="做调研", agent_id="agent-1", role="研究员")
    state = RunState(
        model=DEEPSEEK_V4_PRO,
        rounds=2,
        duration_ms=1234,
        usage={"input": 100, "output": 50, "reasoning": 10, "cache_hit": 60, "cache_miss": 40},
        cost={"input": 999, "cached": 111, "output": 222, "total": 1221},
    )

    row = member_run_cost(spec, state, parent_run_id="cap-1")

    assert row.role == ROLE_MEMBER
    assert row.run_id == "run-1"
    assert row.parent_run_id == "cap-1"
    assert row.agent_id == "agent-1"
    assert row.model == DEEPSEEK_V4_PRO
    assert row.tokens == {
        "input": 100,
        "output": 50,
        "reasoning": 10,
        "cache_hit": 60,
        "cache_miss": 40,
    }
    # Cost read straight off the state (no recompute); total mirrored to the
    # redundant scalar the account-window SUM runs on.
    assert row.cost == {"input": 999, "cached": 111, "output": 222, "total": 1221}
    assert row.cost_total_nano == 1221
    assert row.rounds == 2
    assert row.duration_ms == 1234
    assert row.currency == "USD"


def test_member_run_cost_defaults_agent_id_to_run_id():
    # 阶段1: agent_id == run_id; when a spec omits agent_id the row falls back to it.
    spec = RunSpec(run_id="run-x", task="t", role="r")
    state = RunState(model=DEEPSEEK_V4_FLASH, usage={"input": 1}, cost={"total": 0})

    row = member_run_cost(spec, state, parent_run_id=None)

    assert row.agent_id == "run-x"
    assert row.parent_run_id is None


def test_captain_run_cost_prices_once_via_calculate_cost():
    # The captain has no RunState, so it is priced here — and must agree exactly
    # with the single calculate_cost (the one place pricing happens).
    usage = TokenUsage(
        input_tokens=2_000_000,
        output_tokens=1_000_000,
        reasoning_tokens=0,
        cache_hit_tokens=1_000_000,
        cache_miss_tokens=1_000_000,
    )

    row = captain_run_cost(
        run_id="cap-1", model=DEEPSEEK_V4_FLASH, usage=usage, rounds=3, duration_ms=4321
    )
    expected = calculate_cost(DEEPSEEK_V4_FLASH, usage)

    assert row.role == ROLE_CAPTAIN
    assert row.run_id == "cap-1"
    assert row.parent_run_id is None  # the root run
    assert row.agent_id is None
    assert row.tokens == usage.as_dict()
    assert row.cost == {
        "input": expected.input,
        "cached": expected.cached,
        "output": expected.output,
        "total": expected.total,
    }
    assert row.cost_total_nano == expected.total
    # Concrete nano-USD (Flash tier): cache_hit 2.8e6 + cache_miss 1.4e8 = input,
    # output 2.8e8 — pins both the split pricing and the int coercion.
    assert row.cost["cached"] == 2_800_000
    assert row.cost["input"] == 142_800_000
    assert row.cost["output"] == 280_000_000
    assert row.cost["total"] == 422_800_000
    assert row.rounds == 3
    assert row.duration_ms == 4321


def test_captain_cost_values_are_integers():
    # Money is integer nano-USD end to end — no Decimal/float may leak out.
    usage = TokenUsage(input_tokens=123, output_tokens=45, cache_miss_tokens=123)

    row = captain_run_cost(
        run_id="c", model=DEEPSEEK_V4_FLASH, usage=usage, rounds=1, duration_ms=0
    )

    assert all(isinstance(v, int) for v in row.cost.values())
    assert isinstance(row.cost_total_nano, int)


def test_aggregate_cost_sums_priced_rows_across_tiers():
    # The turn total (message_end.cost) is the SUM of the already-priced rows, NOT
    # a re-price of the combined usage — a captain on Flash + a member on Pro must
    # add up component-wise, each at its own tier.
    captain = asdict(
        captain_run_cost(
            run_id="cap",
            model=DEEPSEEK_V4_FLASH,
            usage=TokenUsage(cache_miss_tokens=1_000_000, output_tokens=1_000_000),
            rounds=1,
            duration_ms=0,
        )
    )
    member = {
        "run_id": "mem",
        "parent_run_id": "cap",
        "agent_id": "mem",
        "role": ROLE_MEMBER,
        "model": DEEPSEEK_V4_PRO,
        "tokens": {"input": 1, "output": 1, "reasoning": 0, "cache_hit": 0, "cache_miss": 1},
        "cost": {"input": 100, "cached": 0, "output": 200, "total": 300},
        "cost_total_nano": 300,
        "currency": "USD",
        "rounds": 1,
        "duration_ms": 5,
    }

    agg = aggregate_cost([captain, member])

    assert agg["input"] == captain["cost"]["input"] + 100
    assert agg["cached"] == captain["cost"]["cached"] + 0
    assert agg["output"] == captain["cost"]["output"] + 200
    # Total mirrors the redundant scalar the account-window SUM runs on.
    assert agg["total"] == captain["cost_total_nano"] + 300
    assert agg["total"] == agg["input"] + agg["output"]
    assert agg["currency"] == "USD"


def test_aggregate_cost_empty_is_zero():
    # A turn with no priced runs (nothing metered) aggregates to a clean zero
    # block rather than an empty dict, so message_end.cost is always well-formed.
    assert aggregate_cost([]) == {
        "input": 0,
        "cached": 0,
        "output": 0,
        "total": 0,
        "currency": "USD",
    }
