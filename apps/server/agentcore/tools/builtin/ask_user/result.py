"""Map ask_user checkpoint responses to tool results (live + resume shared)."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.tools.protocol import ToolEffect, ToolResult


def confirmed_defaults_summary(
    questions: list[dict[str, Any]] | None = None,
    assumptions: list[dict[str, Any]] | None = None,
) -> str:
    """Join card ``default`` / assumption labels for empty-continue inject (案 B)."""
    parts: list[str] = []
    for q in questions or []:
        if not isinstance(q, dict):
            continue
        default = str(q.get("default") or "").strip()
        if not default:
            continue
        prompt = str(q.get("prompt") or "").strip()
        parts.append(f"{prompt}={default}" if prompt else default)
    for a in assumptions or []:
        if not isinstance(a, dict):
            continue
        label = str(a.get("label") or "").strip()
        if not label:
            continue
        value = str(a.get("value") or "").strip()
        parts.append(f"{label}={value}" if value else label)
    return "；".join(parts)


def ask_user_tool_result(
    response: CheckpointResponse,
    *,
    questions: list[dict[str, Any]] | None = None,
    assumptions: list[dict[str, Any]] | None = None,
) -> ToolResult:
    """Map the user's ask_user answer to the tool result the CEO loop consumes.

    The single source of truth for both the live tool (``AskUserTool.execute``) and
    a durable resume (``runtime/pipeline.resume_chat_pipeline``): submit feeds back as
    a ``CONTINUE`` result (the CEO resumes); stop returns an ``INTERACT`` (terminal)
    result whose optional closing note rides as ``final_text`` (empty when the user
    left no note — stop status lives on the interaction card, not a canned assistant
    line); a timeout hands control back to the CEO to wrap up on its own. Pure (no SSE
    side-effect): the caller streams a non-empty stop ``final_text`` via
    ``content_delta`` (it is persist-only, the engine never re-emits it).

    答复正文 (α 答复模型): the desktop composes the user's per-question picks + style +
    free-form note into ONE readable ``note`` string (the picks live in the UI, so the
    answer is composed where the data is — no structured wire payload the only-reader CEO
    would just flatten back to prose anyway).

    Empty continue (no note/picks) with card defaults → inject「用户确认默认：…」so the
    resumed CEO must honor those defaults and mark「按确认默认」(案 0cb83288 · B)；
    no card default → legacy「按你提出的方向继续」fallback (Cursor 空 continue ≈ 接受默认).
    """
    decision = response.decision
    if decision is CheckpointDecision.ADJUST:
        raise ValueError("ask_user checkpoints do not accept ADJUST; use CONTINUE with note")
    picks = "、".join(response.selected)
    note = response.note.strip()
    if decision is CheckpointDecision.CONTINUE:
        if note and picks:
            output = f"用户选择：{picks}；并补充：\n{note}\n请据此继续。"
        elif note:
            # The desktop's composed answer (per-question picks + style + note) rides here.
            output = f"用户答复：\n{note}\n请据此继续。"
        elif picks:
            output = f"用户选择：{picks}。请按此继续。"
        else:
            defaults = confirmed_defaults_summary(questions, assumptions)
            if defaults:
                output = (
                    f"用户确认默认：{defaults}。"
                    "请按确认默认推进派工/正文，并在正文标「按确认默认」；"
                    "【禁止】借继续另拟一套，也【禁止】再写「先问你 / 请选择 / 方向：先问你」。"
                )
            else:
                output = "用户确认：按你提出的方向继续。"
        return ToolResult(tool_call_id="", success=True, output=output)
    if decision is CheckpointDecision.STOP:
        return ToolResult(
            tool_call_id="",
            success=True,
            output="用户取消未回答。",
            effect=ToolEffect.INTERACT,
            final_text=note,
        )
    # TIMEOUT — never silently picked a branch; let the CEO decide how to close.
    return ToolResult(
        tool_call_id="",
        success=True,
        output="用户未在时限内回应。请基于目前已掌握的信息，自行决定如何稳妥收尾。",
    )


def ask_user_organize_plan_result(
    response: CheckpointResponse, *, plan_id: str, kept_count: int
) -> ToolResult:
    """CONTINUE result for organize_plan — embeds plan_id for file_batch binding."""
    base = ask_user_tool_result(response)
    if response.decision is not CheckpointDecision.CONTINUE:
        return base
    suffix = (
        f"\n整理方案已确认：plan_id={plan_id}，保留 {kept_count} 项。"
        "请用 file_batch(organize_plan_id=该 id, operations=保留项) 分批执行"
        f"（每批≤50），勿再弹审批。完成后可用 file_batch(organize_undo=true) 撤销。"
    )
    return ToolResult(
        tool_call_id="",
        success=True,
        output=(base.output or "") + suffix,
    )


def ask_user_daily_review_result(
    response: CheckpointResponse,
    *,
    applied: int,
    skipped: int,
    errors: tuple[str, ...] = (),
) -> ToolResult:
    """CONTINUE/STOP result after server-side daily_review apply."""
    if response.decision is not CheckpointDecision.CONTINUE:
        return ask_user_tool_result(response)
    err_bit = f"；问题：{'；'.join(errors)}" if errors else ""
    output = (
        f"用户已确认复盘提案。服务端已落盘 {applied} 项"
        f"（跳过 {skipped}）{err_bit}。"
        "请用白话写一段短收尾说明落了什么；"
        "禁止再调用 remember / file_write / update_project_profile 重复写入。"
    )
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        effect=ToolEffect.CONTINUE,
    )
