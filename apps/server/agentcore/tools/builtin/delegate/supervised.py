"""受监督的波循环：晚绑定 / scope 偏离 / replan 续跑。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.tools.builtin.delegate.schema import DELEGATE_OUTPUT_LIMIT, PLAN_REVIEW_SUMMARY_CHARS
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.runtime.runs.scheduler import BoundaryReason
    from agentcore.runtime.runs.types import RunSpec, RunState
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


@dataclass
class SupervisedRun:
    """A delegate plan paused at a decision boundary, awaiting the CEO's ``replan`` (受监督
    的波循环). Holds exactly what :meth:`DelegateTool.replan` needs to finalise / re-steer
    and resume the SAME DAG from where it yielded: the (mutable) plan, the completed-so-far
    seeds, the turn's execution id, the original ``finalize`` flag, the ``reason`` it
    yielded for (``BIND`` = late-bind a placeholder, ``SCOPE`` = re-steer the tail after a
    队员 deviation — gates ``replan``'s required-field check), and the run_ids that triggered
    the yield (the late-bound node for BIND, the deviating node for SCOPE).
    """

    plan: RunPlan
    completed: dict[str, RunState]
    execution_id: str
    finalize: bool
    reason: BoundaryReason
    boundary_run_ids: list[str]


def apply_replan(
    tool: DelegateTool,
    plan: RunPlan,
    completed: dict[str, RunState],
    binds: list,
    steers: list,
) -> list[str]:
    """Validate then apply a replan's binds + steers to the paused plan in place."""
    valid_tools = {s.name for s in tool._tools.list_all()}
    errors: list[str] = []
    bind_ops: list[tuple[RunSpec, dict[str, Any]]] = []
    for i, b in enumerate(binds):
        if not isinstance(b, dict):
            errors.append(f"binds[{i}] 必须是对象")
            continue
        rid = str(b.get("run_id") or "").strip()
        node = plan.by_id(rid) if rid else None
        if node is None:
            errors.append(f"binds[{i}]: run_id `{rid}` 不在当前计划")
            continue
        if not node.bind_after_deps:
            errors.append(f"binds[{i}]: `{rid}` 不是待定稿（晚绑定）步骤")
            continue
        if rid in completed:
            errors.append(f"binds[{i}]: `{rid}` 已完成")
            continue
        role = b.get("role")
        task = b.get("task")
        final_role = role.strip() if isinstance(role, str) and role.strip() else node.role
        final_task = task.strip() if isinstance(task, str) and task.strip() else node.task
        if not final_role:
            errors.append(f"binds[{i}]: `{rid}` 定稿需要 role")
            continue
        if not final_task:
            errors.append(f"binds[{i}]: `{rid}` 定稿需要 task")
            continue
        fields: dict[str, Any] = {"role": final_role, "task": final_task}
        objective = b.get("objective")
        if isinstance(objective, str) and objective.strip():
            fields["objective"] = objective.strip()
        expected = b.get("expected_output")
        if isinstance(expected, str) and expected.strip():
            fields["expected_output"] = expected.strip()
        mp = b.get("model_preference")
        if mp in ("fast", "strong"):
            fields["model_preference"] = mp
        tools = b.get("tools")
        if isinstance(tools, list):
            named = [t for t in tools if isinstance(t, str) and t in valid_tools]
            fields["tools"] = named or None
        bind_ops.append((node, fields))

    steer_ops: list[tuple[RunSpec, str]] = []
    for i, s in enumerate(steers):
        if not isinstance(s, dict):
            errors.append(f"steers[{i}] 必须是对象")
            continue
        rid = str(s.get("run_id") or "").strip()
        note = str(s.get("note") or "").strip()
        node = plan.by_id(rid) if rid else None
        if node is None:
            errors.append(f"steers[{i}]: run_id `{rid}` 不在当前计划")
            continue
        if rid in completed:
            errors.append(f"steers[{i}]: `{rid}` 已完成，无法操舵")
            continue
        if not note:
            errors.append(f"steers[{i}]: 缺少 note")
            continue
        steer_ops.append((node, note))

    if errors:
        return errors
    for node, fields in bind_ops:
        for key, value in fields.items():
            setattr(node, key, value)
        node.bind_after_deps = False
    for node, note in steer_ops:
        node.steer = f"{node.steer}\n- {note}" if node.steer else f"- {note}"
    return []


async def finalize_stopped(
    tool: DelegateTool, plan: RunPlan, seed_completed: dict[str, RunState]
) -> ToolResult:
    """Wrap up a partial plan without running the tail."""
    from agentcore.runtime.runs import RunPhase, RunState
    from agentcore.tools.builtin.delegate.ceo_format import format_for_ceo
    from agentcore.tools.builtin.delegate.accumulate import (
        accumulate_usage,
        collect_citations,
        collect_ledger,
        register_sessions,
    )

    results: dict[str, RunState] = dict(seed_completed)
    for node in plan.nodes:
        results.setdefault(node.run_id, RunState(phase=RunPhase.SKIPPED))
    accumulate_usage(tool, results)
    collect_ledger(tool, plan, results)
    collect_citations(tool, results)
    registered = register_sessions(tool, plan, results)
    if tool._session_saver is not None:
        for session in registered:
            await tool._session_saver(session)
    return ToolResult(
        tool_call_id="",
        success=True,
        output=format_for_ceo(tool, plan, results),
        output_limit=DELEGATE_OUTPUT_LIMIT,
    )


def format_boundary_for_ceo(
    tool: DelegateTool,
    reason: BoundaryReason,
    plan: RunPlan,
    results: dict,
    nodes: list[RunSpec],
) -> str:
    """The CEO-facing「计划已让出」brief when a supervised plan YIELDs."""
    from agentcore.runtime.runs import BoundaryReason

    if reason is BoundaryReason.SCOPE:
        return format_scope_boundary(plan, results, nodes)
    return format_bind_boundary(plan, results, nodes)


def format_bind_boundary(plan: RunPlan, results: dict, nodes: list[RunSpec]) -> str:
    """BIND-arm brief (晚绑定)."""
    from agentcore.runtime.runs import RunPhase

    lines = [
        "## 计划已让出（请定稿待绑定步骤后续跑）",
        "下列步骤声明了「依赖完成后再定稿」(bind_after_deps)：其上游已就位，现在由你"
        "依据上游产出把它们的职责 / 任务定稿，然后用 `replan` 续跑同一计划。",
    ]
    for node in nodes:
        dep_lines: list[str] = []
        for dep_id in node.depends_on:
            state = results.get(dep_id)
            summary = (state.content if state else "") or ""
            if len(summary) > PLAN_REVIEW_SUMMARY_CHARS:
                summary = summary[:PLAN_REVIEW_SUMMARY_CHARS] + "…"
            dep = plan.by_id(dep_id)
            dep_role = (dep.role if dep else dep_id) or dep_id
            dep_lines.append(f"  - 上游 `{dep_id}`（{dep_role}）：{summary or '（无产出）'}")
        lines.append(
            f"\n### 待定稿 · run_id: `{node.run_id}`"
            f"（占位角色：{node.role or '未填'}）\n"
            f"占位任务：{node.task or '（未填）'}\n"
            "依赖产出：\n" + ("\n".join(dep_lines) or "  - （无上游）")
        )
    pending = [n.run_id for n in plan.nodes if n.run_id not in results]
    done = sum(1 for s in results.values() if s and s.phase is RunPhase.COMPLETED)
    lines.append(
        "\n---\n请调用 `replan` 定稿上述步骤："
        "`binds=[{run_id, role, task, …}]`（定稿后该步即可运行）；可选 "
        "`steers=[{run_id, note}]` 操舵其它未跑步骤；确无需继续则 `replan(stop=true)`。\n"
        f"当前已完成 {done} 步；待跑：{('、'.join(f'`{p}`' for p in pending)) or '（无）'}。"
    )
    return "\n".join(lines)


def format_scope_boundary(plan: RunPlan, results: dict, nodes: list[RunSpec]) -> str:
    """SCOPE-arm brief (偏离信号)."""
    from agentcore.runtime.runs import RunPhase

    lines = [
        "## 计划已让出（队员报告职责偏离，请校准未跑步骤）",
        "下列【已完成】步骤报告了「职责/范围偏离」(escalate kind=scope)：它们在执行中发现"
        "真正要做的与初始计划不符。请阅读它们的产出与偏离说明，判断是否需要操舵【尚未运行】"
        "的下游步骤，再用 `replan` 续跑同一计划。",
    ]
    for node in nodes:
        state = results.get(node.run_id)
        summary = (state.content if state else "") or ""
        if len(summary) > PLAN_REVIEW_SUMMARY_CHARS:
            summary = summary[:PLAN_REVIEW_SUMMARY_CHARS] + "…"
        esc_lines: list[str] = []
        for e in state.escalations if state else []:
            if e.get("kind") != "scope":
                continue
            question = str(e.get("question") or "").strip()
            assumption = str(e.get("assumption") or "").strip()
            esc_lines.append(f"  - 偏离：{question or '（未写明）'}")
            if assumption:
                esc_lines.append(f"    暂定假设：{assumption}")
        lines.append(
            f"\n### 偏离 · run_id: `{node.run_id}`（{node.role or node.run_id}）\n"
            f"产出：{summary or '（无产出）'}\n"
            "偏离说明：\n" + ("\n".join(esc_lines) or "  - （未写明）")
        )
    pending = [n.run_id for n in plan.nodes if n.run_id not in results]
    done = sum(1 for s in results.values() if s and s.phase is RunPhase.COMPLETED)
    lines.append(
        "\n---\n请调用 `replan` 校准未跑步骤：`steers=[{run_id, note}]` 操舵尚未运行的下游"
        "（运行前注入指令）；若某步是『待定稿』可一并 `binds=[…]` 定稿；确认无需改动可直接 "
        "`replan()` 续跑；确无需继续则 `replan(stop=true)`。\n"
        f"当前已完成 {done} 步；待跑：{('、'.join(f'`{p}`' for p in pending)) or '（无）'}。"
    )
    return "\n".join(lines)
