"""Worker usage / ledger / citations / session roster accumulation."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool


def accumulate_usage(tool: DelegateTool, results: dict) -> dict[str, int]:
    """Sum this call's worker token usage and fold it into the turn total."""
    call = {"input": 0, "output": 0, "reasoning": 0, "cache_hit": 0, "cache_miss": 0}
    for state in results.values():
        for key in call:
            call[key] += state.usage.get(key, 0)
    tool._acc.add_usage(call)
    return call


def collect_ledger(tool: DelegateTool, plan: RunPlan, results: dict) -> None:
    """Capture each worker run that metered LLM usage as a per-run cost row."""
    for node in plan.nodes:
        state = results.get(node.run_id)
        if state:
            tool._acc.add_run_cost(node, state, parent_run_id=tool._captain_run_id)


def collect_citations(tool: DelegateTool, results: dict) -> None:
    """Fold COMPLETED workers' web sources into this turn's source list."""
    for state in results.values():
        tool._acc.add_citations(state)


def register_sessions(tool: DelegateTool, plan: RunPlan, results: dict) -> list:
    """Keep each COMPLETED worker alive as a recoverable RunSession (留人)."""
    if tool._session_store is None:
        return []
    from agentcore.runtime.runs import RunPhase, RunSession

    registered = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        if state and state.phase is RunPhase.COMPLETED and state.transcript:
            session = RunSession(
                run_id=node.run_id,
                spec=node,
                transcript=state.transcript,
                content=state.content,
            )
            tool._session_store.put(session)
            registered.append(session)
    return registered
