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
    from agentcore.runtime.runs.types import RunState
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


def direct_result(tool: DelegateTool, state: RunState) -> ToolResult:
    """提案2a：把单个成功 worker 的产出直接作为本回合最终答复（HANDOFF 终态）。"""
    # 完工交接简报: the brief is structured (``state.debrief``, submitted via the worker's handoff
    # tool — never mixed into the prose), so the deliverable IS the clean answer as-is. If the
    # author suggested a 建议下一步, re-attach it as a readable footer (there is no CEO synthesis
    # pass here to relay it).
    text = state.content
    next_steps = (state.debrief or {}).get("next_steps", "") if state.debrief else ""
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
    from agentcore.runtime.runs.types import RunPhase

    # Hot-redirect revisions (``{run_id}_revN``) are not plan nodes; map original → revision
    # so a CANCELLED+redirected worker surfaces its continued product, not「无输出」.
    hot_by_original: dict[str, tuple[str, Any]] = {}
    plan_ids = {n.run_id for n in plan.nodes}
    for rid, st in results.items():
        if rid in plan_ids or st is None:
            continue
        if st.phase is not RunPhase.COMPLETED or not (st.content or "").strip():
            continue
        # Naming: continue_run / revise use ``{target}_rev{n}``
        if "_rev" in rid:
            orig = rid.rsplit("_rev", 1)[0]
            if orig in plan_ids:
                hot_by_original[orig] = (rid, st)

    # 完工交接简报: the content is already the pure deliverable (each worker's brief rides its
    # structured ``debrief`` from the handoff tool — never appended to the prose), so the body
    # sizes on the deliverable alone, the author's own 结论 LEADS the body, and 建议下一步 is
    # surfaced separately (format_for_ceo) for the CEO to relay to the user.
    cleaned: dict[str, tuple[str, dict[str, Any] | None]] = {}
    for node in plan.nodes:
        st = results.get(node.run_id)
        if node.run_id in hot_by_original:
            _rid, hot_st = hot_by_original[node.run_id]
            cleaned[node.run_id] = (hot_st.content, hot_st.debrief)
        else:
            cleaned[node.run_id] = (st.content, st.debrief) if st and st.content else ("", None)

    def _mode(node) -> str:
        if node.run_id in hot_by_original:
            _rid, hot_st = hot_by_original[node.run_id]
            if hot_st.files_touched:
                return "pointer"
            return "pass_through" if hot_st.content else "none"
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
    # Cold handoff: a CANCELLED original that a ``_redir`` (replaces_run_id) took over
    # must not surface as「失败/被跳过」— the handoff node is the product.
    replaced_ids = {n.replaces_run_id for n in plan.nodes if n.replaces_run_id}

    products: list[dict[str, Any]] = []
    for node in plan.nodes:
        state = results.get(node.run_id)
        if (
            state is not None
            and state.phase is RunPhase.CANCELLED
            and node.run_id in replaced_ids
            and node.run_id not in hot_by_original
        ):
            continue
        hot = hot_by_original.get(node.run_id)
        if hot is not None:
            status = "completed"
            state = hot[1]
        else:
            status = state.phase.value if state else "unknown"
        label = node.role or node.run_id
        mode = modes[node.run_id]
        clean, debrief = cleaned[node.run_id]
        author_summary = (debrief or {}).get("summary", "") if debrief else ""
        next_steps = (debrief or {}).get("next_steps", "") if debrief else ""
        fidelity = ""
        truncated = False
        if mode == "pointer":
            # HEAD+TAIL digest (not head-only): the full product is on disk (pointer), and the
            # digest keeps the deliverable's opening AND its tail so 收尾 / 关键取舍 aren't dropped.
            body = truncate_head_tail(clean, DEP_POINTER_SUMMARY_CHARS)
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
                "run_id": hot[0] if hot else node.run_id,
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


def format_for_ceo(
    tool: DelegateTool, plan: RunPlan, results: dict, *, call_idx: int | None = None
) -> str:
    """Render the workers' products as the CEO's overview input."""
    lines = ["## 团队执行结果（据此写一段简短概览交给用户；完整详情用户自行查看）"]
    escalation = escalation_block(tool, plan, results)
    if escalation:
        lines.append(escalation)

    from agentcore.tools.builtin.delegate.completion import (
        collect_worker_gaps,
        format_worker_gaps_block,
    )

    gaps_block = format_worker_gaps_block(collect_worker_gaps(plan, results))
    if gaps_block:
        lines.append(gaps_block)

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
        "\n---\n以上为团队产出。各成员的「文件产出（已写入工作区）」行是落盘的地面真相。\n"
        "⚠️ 防幻觉铁律：worker 是否真写了文件，只看「文件产出」行——正文声称写了却无此行 = 未真正"
        "落盘，判为【未达成】，用 revise 唤回落盘或重新委派。纯文本产出的 worker（调研 / 分析等）"
        "无文件产出属正常。\n"
        "多路并行且相互依赖时，做一步【语义边界对账】：查冲突（双方对同一接口假设不一致）、"
        "缺口（掉在缝里没人做）、重复（两人做了同一件事）；上方若有【团队便签】一并对照。"
        "对出问题用 revise / replan 修，别糊过去。独立并行（各干各的）跳过此步。\n"
        "收尾前对照用户原始请求做【完工核验】：每件事是否实质达成？未达成就补（delegate / replan / "
        "revise），已达成就自信收口、不无谓空转。然后用你自己的声音写一段简短概览，串起各人结论，"
        "指引用户看细节，不逐字复述。如有队员建议的下一步，择有价值者带给用户。"
    )
    output = "\n".join(lines)
    if any(wp["status"] != "completed" for wp in products):
        output += (
            "\n---\n**有队员失败/被跳过。** 如需补跑，请用 `replan(add=[...])` 在同一计划中追加替换节点"
            "（可引用本批已完成节点的 run_id 作为 depends_on），而非重新调用 delegate。"
            "若无需补跑，直接回复用户即可。"
        )
    raw_chars = sum(len(s.content) for s in results.values() if s and s.content)
    logger.info(
        "delegate.synthesis",
        call=call_idx if call_idx is not None else tool._calls,
        workers=len(plan.nodes),
        pointers=sum(1 for p in products if p["fidelity"] == "pointer"),
        prose=sum(1 for p in products if p["fidelity"] == "pass_through"),
        raw_chars=raw_chars,
        final_chars=len(output),
        ratio=round(len(output) / raw_chars, 2) if raw_chars else 1.0,
        capped=len(output) > DELEGATE_OUTPUT_LIMIT,
    )
    return output
