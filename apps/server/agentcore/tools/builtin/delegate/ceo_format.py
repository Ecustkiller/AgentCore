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
    from agentcore.runtime.runs.serialize import split_debrief

    # 完工交接简报: a worker's「## 交接简报」is a handoff for the team, not part of the
    # user-facing answer — strip it on the finalize path. If it suggested a 建议下一步,
    # re-attach it as a clean footer (there is no CEO synthesis pass here to relay it).
    clean, debrief = split_debrief(content)
    text = clean or content
    next_steps = (debrief or {}).get("next_steps", "") if debrief else ""
    if next_steps:
        text = f"{text}\n\n---\n**建议下一步**：{next_steps}"
    tool._sink.emit(content_delta(text))
    return ToolResult(
        tool_call_id="",
        success=True,
        output=text,
        output_limit=DELEGATE_OUTPUT_LIMIT,
        effect=ToolEffect.HANDOFF,
        final_text=text,
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
            # 卡在缺输入·依赖缺口 (§2.4 变·worker 的「拉」): if this run got here (synthesis) rather
            # than being settled at the reactive wave boundary, mark it so the CEO补 a producer.
            is_dep = e.get("kind") == "dep"
            mark = "【关键阻塞】" if blocking else ("【缺输入·依赖缺口】" if is_dep else "")
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
            "作者据答案重做的就用 revise 唤回；标【缺输入·依赖缺口】的是队员卡在缺一个还不存在"
            "的输入——用 delegate 补一个产出它的步骤，再用 revise 把结果交回原作者据此续写。\n"
            + "\n".join(line for _, line in pending)
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
    from agentcore.runtime.runs.serialize import split_debrief
    from agentcore.runtime.workspace import summarize

    # 完工交接简报: peel each worker's「## 交接简报」off its product ONCE — the prose body sizes on
    # the deliverable alone, the author's own 结论 LEADS the body, and 建议下一步 is surfaced
    # separately (format_for_ceo) for the CEO to relay to the user.
    cleaned: dict[str, tuple[str, dict[str, Any] | None]] = {}
    for node in plan.nodes:
        st = results.get(node.run_id)
        cleaned[node.run_id] = split_debrief(st.content) if st and st.content else ("", None)

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
                len(cleaned[node.run_id][0])
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
        clean, debrief = cleaned[node.run_id]
        author_summary = (debrief or {}).get("summary", "") if debrief else ""
        next_steps = (debrief or {}).get("next_steps", "") if debrief else ""
        fidelity = ""
        truncated = False
        if mode == "pointer":
            body = summarize(clean, limit=DEP_POINTER_SUMMARY_CHARS)
            fidelity, truncated = "pointer", True
        elif mode == "pass_through":
            allowance = next(allowances)
            body = truncate_head_tail(clean, allowance)
            fidelity = "pass_through"
            truncated = len(clean) > allowance
        elif state and state.error:
            body = f"（失败：{state.error}）"
        else:
            body = "（无输出）"
        # Lead the CEO's per-worker view with the author's own 结论 (cheapest, trim-proof).
        if author_summary and mode in ("pointer", "pass_through"):
            body = f"交接结论：{author_summary}\n\n{body}"
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
                "next_steps": next_steps,
            }
        )
    return products


def team_notes_block(tool: DelegateTool) -> str:
    """The CEO-facing【团队便签】section feeding 合·对账 (§2.3), or "" when the wall is empty / absent.

    The batch's NoteWall (owned by ``drive``, stashed on the tool) holds the 决定 / 认领 / 提醒 the
    team broadcast while working — its outstanding ACTIVE notes are the ready-made input to the
    semantic-boundary reconciliation in the closing instruction (便签墙本身又是对账的现成输入).
    Absent (a CEO that never delegated) or empty (nothing posted / all retracted) ⇒ "" so nothing
    is added — 零行为变化 for a team that didn't use the wall."""
    wall = tool._note_wall
    if wall is None:
        return ""
    notes = wall.active_notes()
    if not notes:
        return ""
    from agentcore.runtime.runs.notewall import format_notes_for_synthesis

    return "\n" + format_notes_for_synthesis(notes)


def format_for_ceo(tool: DelegateTool, plan: RunPlan, results: dict) -> str:
    """Render the workers' products as the CEO's overview input."""
    lines = ["## 团队执行结果（据此写一段简短概览交给用户；完整详情用户自行查看）"]
    escalation = escalation_block(tool, plan, results)
    if escalation:
        lines.append(escalation)

    products = worker_products(tool, plan, results)
    emit_captain_readback(tool, products)
    # 完工交接简报: surface each worker's 建议下一步 (proactive, non-blocking — distinct from the
    # escalation block's 待决问题) as ONE advisory section so the CEO can relay the worthwhile
    # ones to the user. Empty when nobody suggested anything.
    suggestions = [(wp["role"], wp["next_steps"]) for wp in products if wp.get("next_steps")]
    if suggestions:
        lines.append(
            "\n### 队员建议的下一步（供参考，由你与用户定夺，非必须执行）\n"
            "以下是各队员完工时顺带提的后续方向（非阻塞、不是待决问题）。择其有价值者，在你给"
            "用户的概览里自然带出『团队建议接下来可以…』即可；无价值的忽略，不要逐条复述。\n"
            + "\n".join(f"- {role}：{ns}" for role, ns in suggestions)
        )
    # 团队便签 → 合·对账 (§2.3): surface the team's outstanding broadcast 决定 / 认领 so the CEO
    # reconciles the assembled result against them in the closing instruction (the wall is 对账 的
    # 现成输入). Empty wall / a CEO that never delegated ⇒ "" → nothing added.
    notes_block = team_notes_block(tool)
    if notes_block:
        lines.append(notes_block)
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
        "若本次是【相互依赖、要拼到一起】的并行（多块共享同一接口 / 数据格式 / 字段，或一块产出要被"
        "另一块接住——典型如『接口＋页面＋测试』），合并前先做一步【语义边界对账】：只查三样"
        "『拼不拼得上』、不评每块好不好（后者是各 worker 自带质检那条线，别混）——①【冲突】两块对"
        "同一共享点的假设对不上（一端叫 `/login`、另一端按 `/auth/session`；一端发 `password`、"
        "另一端收 `pwd`）；②【缺口】该做的事掉在分工缝里没人认领（谁都没做错误处理 / 边界态）；"
        "③【重复】两块做了同一件事（上方若有【团队便签】，据队员广播过的决定 / 认领一并对照："
        "决定改了成品没跟上、两人认领了同一块、成品与某条广播决定矛盾）。"
        "这是今天『跑偏只能等 worker 举手(escalate scope)』的主动版"
        "——你主动对一遍、不等谁举手。对出问题别在概览里糊过去：就地用 `revise` 唤回相关产物对齐、"
        "或用 `replan` 操舵 / 追加修一块，高风险需用户拍板时用 `ask_user`。若各块本就【各干各的、"
        "最后汇成一篇】（如查三个不相干话题），无缝可对，跳过这步。\n"
        "收尾前先做一步【对照原始目标的完工核验】（比逐块检查更值钱，别跳过）：把团队已完成的整体"
        "成果，对照【用户最初的请求】以及你当初给各步写的目标 / 预期产出（task / expected_output），"
        "逐条核对——用户真正要的每一件事，是否都【实质达成】了？重点抓两类「面上过了、实则没办成」："
        "①用户明确要的某件事整体掉了、根本没人做到（缺失的功能 / 章节 / 交付物）；②某产物形式上交"
        "了、却答非所问、没解决用户真正要的问题（『跑得通却没解决』那类）。这一层查的是【整体是否达成"
        "原始意图】，与上面的『文件是否真落盘』（防幻觉铁律）、各 worker 自带的质检提醒（单块是否达"
        "标）层次不同、不可互相替代。\n"
        "据此给出明确的【完工判定】，二者择一、别含糊：\n"
        "- 若确有【实质未达成】之处：别假装收工、也别把缺口一笔带过——就地补齐再收尾（缺整块用 "
        "`delegate` 补、在原计划上用 `replan` 追加 / 操舵相应步骤、或让原作者用 `revise` 补正）。\n"
        "- 若已【确实达成】用户所求：就自信收尾，不要为求稳重复委派已做好的事、也不要无谓空转——"
        "达成即应收口。\n"
        "确认达成（或已补齐）后，再用你自己的声音写一段【简短概览】：综述各成员的关键结论、串起整体、"
        "指引用户去看细节即可——不要逐字复述每个 worker 的全文，也不要罗列内部"
        "步骤或 Agent。如仍需补充工作，可再次调用 delegate；若用户希望对其中某个产物"
        "做小改 / 增补、且仍由原角色来改，可用 revise（传该产物上面的 run_id + 修改"
        "意见）唤回原作者在原稿基础上续写，而不必从零重派。"
        "若上方有『队员建议的下一步』，择其有价值者在概览末尾以一句『建议下一步』自然带给用户。"
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
