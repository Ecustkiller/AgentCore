"""Per-run cost ledger rows — RunState/TokenUsage → the ``cost_events`` shape.

决策②: one ledger row per Run = one Agent's participation in a turn (the captain
root included). This module is the single bridge that turns a finished run into a
ledger row, so the delegate tool (members) and the pipeline (captain root) build
rows the *same* way and the repository persists them uniformly.

Money stays integer nano-USD throughout; pricing happens exactly once via
:func:`agentcore.llm.pricing.calculate_cost` in the run executor, which stamps
both the captain root and every delegated worker onto their :class:`RunState`.
This module only *reshapes* those priced states into ledger rows — it never
re-prices.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from agentcore.runtime.runs.types import RunSpec, RunState

# cost_events.role categories (mirror the DB CheckConstraint). 阶段1 only ever
# produces captain + member; arena / title / memory are reserved for later run
# kinds and background LLM calls.
ROLE_CAPTAIN = "captain"
ROLE_MEMBER = "member"

# The four money keys carried in cost_events.cost (integer nano-USD). The Cost
# dataclass also exposes ``currency``, which rides in its own column instead.
_COST_KEYS = ("input", "cached", "output", "total")


@dataclass(frozen=True)
class RunCost:
    """One ledger row's run-specific payload.

    The user / conversation / message envelope is attached at persistence time by
    the conversation service (which owns the DB session), so this stays a pure
    value object the runtime can build without any DB awareness.
    """

    run_id: str
    parent_run_id: str | None
    agent_id: str | None
    role: str
    model: str
    tokens: dict[str, int]
    cost: dict[str, int]
    cost_total_nano: int
    currency: str
    rounds: int
    duration_ms: int


def _split_cost(cost: dict) -> tuple[dict[str, int], int, str]:
    """Normalise a cost dict into (JSONB body, scalar total, currency).

    Accepts the ``asdict(Cost)`` shape (4 money keys + ``currency``); coerces the
    money keys to int (nano-USD is always integral) and pulls the total out for
    the redundant scalar column the account-window SUM runs on.
    """
    body = {key: int(cost.get(key, 0)) for key in _COST_KEYS}
    return body, body["total"], str(cost.get("currency", "USD"))


def member_run_cost(spec: RunSpec, state: RunState, *, parent_run_id: str | None) -> RunCost:
    """A delegated worker's ledger row, read off its terminal :class:`RunState`.

    The executor already priced this run onto ``state.cost``; this only reshapes
    it into a ledger row (no re-pricing). ``parent_run_id`` is the delegating
    captain's run id, so the turn's run tree is reconstructable.
    """
    body, total, currency = _split_cost(state.cost)
    return RunCost(
        run_id=spec.run_id,
        parent_run_id=parent_run_id,
        agent_id=spec.agent_id or spec.run_id,
        role=ROLE_MEMBER,
        model=state.model,
        tokens=dict(state.usage),
        cost=body,
        cost_total_nano=total,
        currency=currency,
        rounds=state.rounds,
        duration_ms=state.duration_ms,
    )


def captain_run_cost_from_state(run_id: str, state: RunState) -> RunCost:
    """The CEO root run's ledger row, read off its terminal :class:`RunState`.

    The captain is now a real Run node executed through the run executor (it owns
    the turn's reply and may ``delegate``), so its cost is priced exactly once —
    onto ``state.cost`` by the executor — and this only reshapes it into the
    captain ledger row (role=captain, no parent: it is the turn's root). The
    delegated workers get their own member rows via :func:`member_run_cost`.
    """
    body, total, currency = _split_cost(state.cost)
    return RunCost(
        run_id=run_id,
        parent_run_id=None,
        agent_id=None,
        role=ROLE_CAPTAIN,
        model=state.model,
        tokens=dict(state.usage),
        cost=body,
        cost_total_nano=total,
        currency=currency,
        rounds=state.rounds,
        duration_ms=state.duration_ms,
    )


def aggregate_cost(cost_runs: Sequence[dict]) -> dict[str, int | str]:
    """Sum per-run cost rows into the turn total carried on ``message_end.cost``.

    Takes the ``asdict(RunCost)`` rows the pipeline builds (captain + members) and
    returns the ``{input, cached, output, total, currency}`` block. The total is
    the SUM of the already-priced rows — never a re-price of the combined usage —
    because workers may run on a different model tier than the captain, so only
    summing the per-run prices stays honest (= ``sum(cost_events.cost_total_nano)``
    for the turn, the §七B「合计」the payroll displays).
    """
    agg = {"input": 0, "cached": 0, "output": 0, "total": 0}
    for row in cost_runs:
        cost = row.get("cost") or {}
        agg["input"] += int(cost.get("input", 0))
        agg["cached"] += int(cost.get("cached", 0))
        agg["output"] += int(cost.get("output", 0))
        agg["total"] += int(row.get("cost_total_nano", cost.get("total", 0)) or 0)
    return {**agg, "currency": "USD"}
