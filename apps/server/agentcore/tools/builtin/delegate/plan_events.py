"""Delegate batch graph / roster SSE payloads."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.runtime.events import run_context, run_plan

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool


def run_payload(node) -> dict[str, Any]:
    """One worker's plan-time descriptor for the graph."""
    payload: dict[str, Any] = {
        "id": node.run_id,
        "agent_id": node.agent_id,
        "task": node.task,
        "depends_on": node.depends_on,
        "parent_run_id": node.parent_run_id,
    }
    if node.stance:
        payload["stance"] = node.stance
    if node.group:
        payload["group"] = node.group
    if node.round:
        payload["round"] = node.round
    if node.replaces_run_id:
        payload["replaces_run_id"] = node.replaces_run_id
    return payload


def captain_card(tool: DelegateTool) -> dict[str, Any]:
    """Roster card for the CEO captain root node."""
    return {
        "id": tool._captain_run_id,
        "role": "CEO",
        "model_preference": "strong",
        "thinking": True,
        "reasoning_effort": "high",
    }


def card(tool: DelegateTool, node) -> dict[str, Any]:
    """Roster entry with the node's declared thinking/effort."""
    return {
        "id": node.agent_id,
        "role": node.role,
        "model_preference": node.model_preference,
        "thinking": node.thinking,
        "reasoning_effort": node.reasoning_effort,
    }


def plan_event(tool: DelegateTool, execution_id: str, plan: RunPlan):
    """Pre-declare this delegate batch's roster + runs so the graph lights up."""
    roles = list(dict.fromkeys(n.role for n in plan.nodes if n.role))
    agents = [card(tool, n) for n in plan.nodes]
    runs = [run_payload(n) for n in plan.nodes]
    if tool._depth == 0 and tool._captain_run_id:
        agents.insert(0, captain_card(tool))
        runs.insert(
            0,
            {
                "id": tool._captain_run_id,
                "agent_id": tool._captain_run_id,
                "task": "",
                "depends_on": [],
                "parent_run_id": None,
                "kind": "captain",
            },
        )
    return run_plan(
        execution_id=execution_id,
        plan_type="multi_agent",
        task_summary=f"{len(plan.nodes)} 个 worker：{'、'.join(roles)}" if roles else "",
        agents=agents,
        runs=runs,
    )


def emit_captain_readback(tool: DelegateTool, products: list[dict[str, Any]]) -> None:
    """上下文传递可视化 通道⑤: ship team products back to the CEO bubble."""
    if tool._depth != 0 or not tool._captain_run_id:
        return
    blocks = [
        {
            "channel": "team_result",
            "heading": f"{wp['role']}（{wp['status']}）",
            "body": wp["body"],
            "chars": len(wp["body"]),
            "truncated": wp["truncated"],
            "source_role": wp["role"],
            "source_run_id": wp["run_id"],
            "fidelity": wp["fidelity"],
            "files": wp["files"],
        }
        for wp in products
    ]
    if blocks:
        tool._sink.emit(run_context(tool._captain_run_id, tool._captain_run_id, blocks))
