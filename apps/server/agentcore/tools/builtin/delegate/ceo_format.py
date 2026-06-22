"""CEO-facing synthesis input formatting."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolEffect
from agentcore.runtime.events import content_delta
from agentcore.tools.builtin.delegate.plan_events import emit_captain_readback
from agentcore.tools.builtin.delegate.schema import DELEGATE_OUTPUT_LIMIT
from agentcore.tools.protocol import ToolResult

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


def direct_result(tool: DelegateTool, content: str) -> ToolResult:
    """提案2a：把单个成功 worker 的产出直接作为本回合最终答复（HANDOFF 终态）。"""
    tool._sink.emit(content_delta(content))
    return ToolResult(
        tool_call_id="",
        success=True,
        output=content,
        output_limit=DELEGATE_OUTPUT_LIMIT,
        effect=ToolEffect.HANDOFF,
        final_text=content,
    )


def escalation_block(tool: DelegateTool, plan: RunPlan, results: dict) -> str:
    """The CEO-facing「队员升级」section, or "" when no worker escalated."""
    pending: list[tuple[bool, str]] = []
    answered: list[str] = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        if not state or not state.escalations:
            continue
        label = node.role or node.run_id
        for e in state.escalations:
            question = str(e.get("question") or "").strip()
            if not question:
                continue
            if str(e.get("status") or "raised") == "resolved":
                answer = str(e.get("answer") or "").strip()
                answered.append(f"- {label}：{question} → 用户已答：{answer}")
                continue
            blocking = bool(e.get("blocking"))
            mark = "【关键阻塞】" if blocking else ""
            line = f"- {mark}{label}：{question}"
            assumption = str(e.get("assumption") or "").strip()
            if assumption:
                line += f"（其暂用假设：{assumption}）"
            pending.append((blocking, line))
    if not pending and not answered:
        return ""
    out = ""
    if pending:
        pending.sort(key=lambda it: not it[0])
        out += (
            "\n### ⚠️ 队员升级了待决问题（请先处理再收尾）\n"
            "以下是队员无法独自拍板、需要你定夺的关键岔路 / 缺失信息。它们已按各自的暂定假设"
            "继续交付，但你应先处理这些问题：能自己答的就在概览里给出并据此判断相关产物是否需"
            "返工；确需用户拍板的就用 ask_user 问（可把问题 near-verbatim 转给用户）；需要原"
            "作者据答案重做的就用 revise 唤回。\n" + "\n".join(line for _, line in pending)
        )
    if answered:
        out += (
            "\n### ✅ 已当场答复的升级（用户在执行中已拍板，无需再问）\n"
            "以下升级队员已直接问到用户、拿到答复并据此续跑；把这些结论纳入你的收尾叙事即可，"
            "不要再用 ask_user 重复问同样的问题。\n" + "\n".join(answered)
        )
    return out


def worker_products(tool: DelegateTool, plan: RunPlan, results: dict) -> list[dict[str, Any]]:
    """Each worker's product folded back to the CEO — SINGLE SOURCE for synthesis + run_context."""
    from agentcore.runtime.runs.constants import CEO_SYNTHESIS_BUDGET, DEP_POINTER_SUMMARY_CHARS
    from agentcore.runtime.runs.fidelity import allocate, truncate_head_tail
    from agentcore.runtime.workspace import summarize

    def _mode(node) -> str:
        st = results.get(node.run_id)
        if not st or not st.content:
            return "none"
        if st.files_touched:
            return "pointer"
        return "pass_through"

    modes = {node.run_id: _mode(node) for node in plan.nodes}
    allowances = iter(
        allocate(
            [
                len(results[node.run_id].content)
                for node in plan.nodes
                if modes[node.run_id] == "pass_through"
            ],
            CEO_SYNTHESIS_BUDGET,
        )
    )
    products: list[dict[str, Any]] = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        status = state.phase.value if state else "unknown"
        label = node.role or node.run_id
        mode = modes[node.run_id]
        fidelity = ""
        truncated = False
        if mode == "pointer":
            body = summarize(state.content, limit=DEP_POINTER_SUMMARY_CHARS)
            fidelity, truncated = "pointer", True
        elif mode == "pass_through":
            allowance = next(allowances)
            body = truncate_head_tail(state.content, allowance)
            fidelity = "pass_through"
            truncated = len(state.content) > allowance
        elif state and state.error:
            body = f"（失败：{state.error}）"
        else:
            body = "（无输出）"
        if state and state.warnings:
            warns = "；".join(state.warnings)
            body += f"\n\n> 质检提醒（未完全达标，请判断是否需要返工）：{warns}"
        if state and state.escalations:
            body += (
                f"\n\n> 已升级 {len(state.escalations)} 项待决问题（见顶部「队员升级了"
                "待决问题」，请先处理再据此判断本产物是否需返工）"
            )
        files = list(state.files_touched) if state and state.files_touched else []
        if files:
            produced = "、".join(f"`{p}`" for p in files)
            body += f"\n\n> 文件产出（已写入工作区）：{produced}"
        products.append(
            {
                "role": label,
                "run_id": node.run_id,
                "status": status,
                "body": body,
                "fidelity": fidelity,
                "truncated": truncated,
                "files": files,
            }
        )
    return products


def format_for_ceo(tool: DelegateTool, plan: RunPlan, results: dict) -> str:
    """Render the workers' products as the CEO's overview input."""
    lines = ["## 团队执行结果（据此写一段简短概览交给用户；完整详情用户自行查看）"]
    escalation = escalation_block(tool, plan, results)
    if escalation:
        lines.append(escalation)

    products = worker_products(tool, plan, results)
    emit_captain_readback(tool, products)
    for wp in products:
        lines.append(
            f"\n### {wp['role']}（{wp['status']}） · run_id: `{wp['run_id']}`\n{wp['body']}"
        )
    lines.append(
        "\n---\n以上为各 worker 的产出（较长或已落盘者在此为摘要 / 指针，完整内容用户可在"
        "界面逐个展开查看，落盘文件你也可 file_read 取用）。各成员写入工作区的"
        "文件已列于其「文件产出（已写入工作区）」一行——这就是本次落盘的产物清单（地面真相）："
        "除非清单为空或明显不全，否则无需再用 file_list / file_read 去工作区核对，直接据此收尾即可。\n"
        "⚠️ 防幻觉铁律：一个 worker 是否真把文件写进了工作区，只以它有没有「文件产出」行为准。"
        "若某 worker 的正文声称 / 暗示自己创建或写入了文件，却没有「文件产出」行（即落盘清单为空），"
        "则这些文件并未真正写入——你绝不能据此向用户报告文件已创建或该交付已完成；应把这类文件"
        "交付判为【未达成】，用 revise 唤回原作者真正调用 file_write 落盘，或重新委派。"
        "（仅产出文本结论的 worker——调研 / 分析 / 辩论 / 对比等——本就没有文件产出，属正常，"
        "不在此列，也不必在概览里提它。）\n"
        "请用你自己的声音写一段【简短概览】：综述各成员的关键结论、串起整体、"
        "指引用户去看细节即可——不要逐字复述每个 worker 的全文，也不要罗列内部"
        "步骤或 Agent。如仍需补充工作，可再次调用 delegate；若用户希望对其中某个产物"
        "做小改 / 增补、且仍由原角色来改，可用 revise（传该产物上面的 run_id + 修改"
        "意见）唤回原作者在原稿基础上续写，而不必从零重派。"
    )
    output = "\n".join(lines)
    raw_chars = sum(len(s.content) for s in results.values() if s and s.content)
    logger.info(
        "delegate.synthesis",
        call=tool._calls,
        workers=len(plan.nodes),
        pointers=sum(1 for p in products if p["fidelity"] == "pointer"),
        prose=sum(1 for p in products if p["fidelity"] == "pass_through"),
        raw_chars=raw_chars,
        final_chars=len(output),
        ratio=round(len(output) / raw_chars, 2) if raw_chars else 1.0,
        capped=len(output) > DELEGATE_OUTPUT_LIMIT,
    )
    return output
