"""Coordination-session terminal event helpers for the drive loop."""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


def collect_harvest_user_facts(plan: Any, results: dict[str, Any] | None) -> dict[str, Any]:
    """Structured session facts for the user-facing harvest fallback renderer.

    Sibling of ``format_for_ceo``: same plan/results, different audience. The CEO
    text stays on ``ALL_COMPLETED.output``; this dict is what the user bubble may
    read. Does not invent gaps — only accepted files and uncompensated tool failures.
    """
    from agentcore.runtime.delegate.team_synthesis import worker_output_blurb
    from agentcore.runtime.runs.file_acceptance import accepted_paths
    from agentcore.runtime.tool_failures import facts_from_dicts, outstanding_facts

    nodes: list[dict[str, Any]] = []
    files: list[str] = []
    outstanding: list[dict[str, Any]] = []
    seen_files: set[str] = set()
    for node in getattr(plan, "nodes", ()) or ():
        rid = str(getattr(node, "run_id", "") or "")
        role = str(getattr(node, "role", None) or getattr(node, "agent_name", None) or "队员")
        state = (results or {}).get(rid)
        if state is not None:
            phase = getattr(state, "phase", None)
            if phase is not None and hasattr(phase, "value"):
                status = phase.value
            else:
                status = str(phase or "pending")
            summary = worker_output_blurb(state)
            node_files = accepted_paths(getattr(state, "file_acceptance", None))
            for fact in outstanding_facts(facts_from_dicts(getattr(state, "tool_failures", None))):
                outstanding.append({"role": role, "tool_name": fact.tool_name})
        else:
            status = "pending"
            summary = ""
            node_files = []
        for path in node_files:
            if path not in seen_files:
                seen_files.add(path)
                files.append(path)
        nodes.append(
            {
                "role": role,
                "status": status,
                "summary": summary,
                "files": list(node_files),
            }
        )
    return {
        "nodes": nodes,
        "files": files,
        "outstanding_tool_failures": outstanding,
    }


def post_session_all_completed(
    session: Any,
    *,
    output: str,
    completed: int | None = None,
    total: int | None = None,
    output_limit: int = 4000,
    criteria_met: bool | None = None,
    failed: int | None = None,
    user_facts: dict[str, Any] | None = None,
) -> None:
    """Post the coordination terminal event (happy path + criteria-gap / partial-fail)."""
    from agentcore.runtime.coordination.session import (
        CoordinationEvent,
        CoordinationEventKind,
    )

    completed_n = completed if completed is not None else len(session.completed_run_ids)
    total_n = total if total is not None else session.total_workers
    payload: dict[str, Any] = {
        "completed": completed_n,
        "total": total_n,
        "output": output[:output_limit],
    }
    if criteria_met is False:
        payload["criteria_met"] = False
    if failed is not None:
        payload["failed"] = failed
    if user_facts:
        payload["user_facts"] = user_facts
        session.harvest_user_facts = user_facts
    session.post(
        CoordinationEvent(
            kind=CoordinationEventKind.ALL_COMPLETED,
            payload=payload,
        )
    )
    # Drive 终态 ≡ wait 可唤醒：终态投递必须可观测（与 wait_end / coord_inject 对照）。
    logger.info(
        "coordination.terminal_posted",
        execution_id=getattr(session, "execution_id", "") or "",
        completed=completed_n,
        total=total_n,
        failed=failed,
        criteria_met=criteria_met,
        output_chars=min(len(output), output_limit),
    )
