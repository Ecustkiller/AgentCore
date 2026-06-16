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

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from agentcore.runtime.citations import merge_citations
from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

# cost_events.role categories (mirror the DB CheckConstraint). 阶段1 only ever
# produces captain + member; arena / title / memory are reserved for later run
# kinds and background LLM calls.
ROLE_CAPTAIN = "captain"
ROLE_MEMBER = "member"

# The four money keys carried in cost_events.cost (integer nano-USD). The Cost
# dataclass also exposes ``currency``, which rides in its own column instead.
_COST_KEYS = ("input", "cached", "output", "total")

# The five short-key token counts carried on RunState.usage / a tool's accumulated
# usage (cache_hit/cache_miss split kept so the folded total stays priceable).
_USAGE_KEYS = ("input", "output", "reasoning", "cache_hit", "cache_miss")


def usage_metadata(usage: Mapping[str, int]) -> dict[str, int]:
    """The ``metadata`` token block a non-terminal orchestration tool returns.

    Re-keys the short-key usage form ({input, ...}) to the engine's ``*_tokens``
    names ({input_tokens, ...}). ``delegate`` (this call's worker usage) and
    ``revise`` (the revision's usage) both report through this single seam so the
    shape can never drift between them.
    """
    return {f"{key}_tokens": int(usage.get(key, 0)) for key in _USAGE_KEYS}


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


class WorkerResultAccumulator:
    """The shared「用量 + 账目 + 引用」roll-up for orchestration tools.

    ``delegate`` (cold workers) and ``revise`` (a recalled author) both spin up
    member runs whose results must fold back into the turn totals the pipeline
    reads: token ``usage`` (summed, cache split kept), a per-run cost ``run_ledger``
    (one row per metered run, 决策②), and the workers' ``citations`` (de-duped into
    the turn's shared source card). Both tools used to hand-roll these three
    identical pieces; they now share this accumulator so the fold logic lives once.

    All three collections are mutated in place — a tool exposes them read-only and
    the pipeline reads ``usage`` / ``run_ledger`` / ``citations`` after the loop.
    """

    def __init__(self) -> None:
        self.usage: dict[str, int] = {key: 0 for key in _USAGE_KEYS}
        self.run_ledger: list[RunCost] = []
        self.citations: list[dict[str, Any]] = []

    def add_usage(self, usage: Mapping[str, int]) -> None:
        """Fold one run's (or sub-team's) short-key token usage into the total."""
        for key in self.usage:
            self.usage[key] += usage.get(key, 0)

    def add_run_cost(self, spec: RunSpec, state: RunState, *, parent_run_id: str | None) -> None:
        """Append a member ledger row for a run that metered LLM usage.

        Runs that never hit the LLM (skipped / failed before any call) carry no
        usage and are not billed, mirroring the old delegate/revise guard.
        """
        if state.usage:
            self.run_ledger.append(member_run_cost(spec, state, parent_run_id=parent_run_id))

    def add_citations(self, state: RunState) -> None:
        """Merge a COMPLETED run's web sources into the shared card (de-duped/capped).

        Only COMPLETED runs contribute — a hard-failed worker's output is discarded
        by the captain, so its sources must not back the answer.
        """
        if state.phase is RunPhase.COMPLETED and state.citations:
            merge_citations(self.citations, state.citations)

    def add_run(self, spec: RunSpec, state: RunState, *, parent_run_id: str | None) -> None:
        """Fold one finished member run end-to-end: usage + ledger row + citations.

        The convenience the ``revise`` path uses (one run per call). ``delegate``
        folds a batch through the granular adders so it can also stage this call's
        usage for the result metadata.
        """
        self.add_usage(state.usage)
        self.add_run_cost(spec, state, parent_run_id=parent_run_id)
        self.add_citations(state)

    def merge(self, other: WorkerResultAccumulator) -> None:
        """Fold another accumulator into this one (a nested sub-team's roll-up).

        Used by ``delegate._absorb_children`` to roll a re-delegating worker's
        sub-team usage + ledger + sources up into this captain's totals.
        """
        self.add_usage(other.usage)
        self.run_ledger.extend(other.run_ledger)
        merge_citations(self.citations, other.citations)
