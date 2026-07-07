"""辩论编排 SSE 事件与主持人计费。"""

from __future__ import annotations

from dataclasses import asdict
from typing import TYPE_CHECKING, Any

from agentcore.llm.profiles import agent_profile
from agentcore.runtime.debate import DebateConfig
from agentcore.runtime.events import run_completed, run_plan
from agentcore.tools.builtin.debate.schema import FORM_LABELS

if TYPE_CHECKING:
    from agentcore.runtime.debate import DebateResult
    from agentcore.runtime.debate.moderator import Moderator
    from agentcore.tools.builtin.debate.tool import DebateTool


def moderator_plan_event(
    tool: DebateTool, execution_id: str, moderator_run_id: str, config: DebateConfig
):
    """声明主持人节点（CEO 之下、辩手之上的编排角色）。CEO 不进图——与 delegate 一致，
    CEO 是主气泡：主持人 ``parent_run_id`` 引用 CEO 的 captain run（节点不在图），团队图
    因此呈现 主持人→辩手 的树。主持人随后走 run_started/run_completed 完整生命周期。"""
    label = FORM_LABELS.get(config.form, "辩论")
    agents: list[dict[str, Any]] = [
        {
            "id": moderator_run_id,
            "role": "主持人",
            "model_preference": "strong",
            "thinking": True,
            "reasoning_effort": "high",
        }
    ]
    runs: list[dict[str, Any]] = [
        {
            "id": moderator_run_id,
            "agent_id": moderator_run_id,
            "task": f"主持{label}：{config.motion[:60]}",
            "depends_on": [],
            "parent_run_id": tool._captain_run_id,
        }
    ]
    return run_plan(
        execution_id=execution_id,
        plan_type="debate",
        task_summary=f"{label}：{config.motion[:60]}",
        agents=agents,
        runs=runs,
    )


def side_card(tool: DebateTool, node) -> dict[str, Any]:
    _ = agent_profile(node.model_preference)
    return {
        "id": node.agent_id,
        "role": node.role,
        "model_preference": node.model_preference,
        "thinking": node.thinking,
        "reasoning_effort": node.reasoning_effort,
    }


def run_payload(node) -> dict[str, Any]:
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
    return payload


def account_moderator(
    tool: DebateTool,
    moderator: Moderator,
    moderator_run_id: str,
    model: str,
    result: DebateResult,
    duration_ms: int,
) -> None:
    """主持人节点收尾：emit run_completed（耗时 + 成本 + 「N 轮·收敛归因」概览，团队图据此
    标完成），并把主持人自身 LLM 调用（议题 / 裁判 / 小结 / 简报）折算成一条主持人节点账目。"""
    from agentcore.llm.pricing import calculate_cost
    from agentcore.runtime.runs.types import RunPhase, RunSpec, RunState

    usage = moderator.usage
    cost = calculate_cost(model, usage)
    summary = result.node_summary
    tool._sink.emit(
        run_completed(
            moderator_run_id,
            moderator_run_id,
            output_summary=summary,
            duration_ms=duration_ms,
            role="主持人",
            model=model,
            usage=usage.as_dict(),
            cost=asdict(cost),
        )
    )
    if usage.total_tokens <= 0:
        return  # 无 LLM 用量（极端）则不另记账目，但主持人节点已 emit 完成态。
    spec = RunSpec(
        run_id=moderator_run_id,
        agent_id=moderator_run_id,
        task="主持辩论",
        role="主持人",
        model_preference="strong",
    )
    state = RunState(
        phase=RunPhase.COMPLETED,
        model=model,
        usage=usage.as_dict(),
        cost=asdict(cost),
        rounds=moderator.llm_rounds,
    )
    tool._acc.add_run_cost(spec, state, parent_run_id=tool._captain_run_id)
    tool._acc.add_usage(usage.as_dict())
