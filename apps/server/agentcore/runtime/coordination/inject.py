"""Format coordination events into CEO ReAct window messages."""

from __future__ import annotations

from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
)
from agentcore.tools.builtin.delegate.team_synthesis import worker_output_blurb


def format_coordination_events(
    session: CoordinationSession,
    events: list[CoordinationEvent],
) -> str:
    """Build a single system-facing brief for a coalesced event batch."""
    lines: list[str] = ["【团队协调事件】"]
    for ev in events:
        lines.append(_format_one(session, ev))
    if session.draft.strip():
        lines.append("")
        lines.append(f"当前合成草稿：\n{session.draft.strip()}")
    lines.append("")
    lines.append(
        "可用工具：update_synthesis(draft) 更新草稿；cancel_worker(run_id, reason) 终止队员；"
        "replan(add=…) 追加队员；resolve_escalation(run_id, answer) 兑现阻塞升级裁决；"
        "ask_user 向用户请示（偏好/授权/费用类须先问用户再 resolve）。"
        "全部完成后做最终合成（走 content_delta），然后退出协调。"
    )
    if session.budget_remaining <= 0:
        lines.append(
            "（协调预算已耗尽：请仅在 all_completed / 冲突时决策，中间进展已合并为摘要。）"
        )
    return "\n".join(lines)


def events_to_messages(
    session: CoordinationSession,
    events: list[CoordinationEvent],
) -> list[LLMMessage]:
    if not events:
        return []
    return [LLMMessage(role="user", content=format_coordination_events(session, events))]


def _format_one(session: CoordinationSession, ev: CoordinationEvent) -> str:
    p = ev.payload
    if ev.kind is CoordinationEventKind.WORKER_COMPLETED:
        role = p.get("role") or p.get("run_id") or "?"
        status = p.get("status") or "completed"
        summary = p.get("summary") or ""
        done = len(session.completed_run_ids)
        total = session.total_workers
        return f"- worker_completed（{done}/{total}）【{role}】{status}：{summary}"
    if ev.kind is CoordinationEventKind.NOTE_POSTED:
        return (
            f"- note_posted【{p.get('role') or p.get('run_id') or '?'}】"
            f"{p.get('kind') or 'note'}：{p.get('text') or ''}"
        )
    if ev.kind is CoordinationEventKind.ESCALATION:
        role = p.get("role") or p.get("run_id") or "?"
        run_id = p.get("run_id") or "?"
        esc_kind = p.get("kind") or "normal"
        src = p.get("source") or "escalate"
        question = p.get("question") or p.get("summary") or ""
        assumption = p.get("assumption") or ""
        if p.get("blocking"):
            assume_bit = f"；队员假设：{assumption}" if assumption else ""
            return (
                f"- escalation【阻塞仲裁】【{role}】run_id={run_id} "
                f"{esc_kind}（via {src}）：{question}{assume_bit}"
                " ——你须仲裁：resolve_escalation(run_id, answer) 直裁；"
                "偏好/授权/费用类须先 ask_user 征询用户，再 "
                "resolve_escalation(run_id, answer, via_user=true)。"
                "超时无响应时队员会按假设继续，勿永久卡住。"
            )
        return (
            f"- escalation【{role}】{esc_kind}（via {src}）：{question}"
            " ——可 update_synthesis 记分歧、cancel_worker、"
            "ask_user 请用户裁决、或 post_note 给指导。"
        )
    if ev.kind is CoordinationEventKind.TIMEOUT:
        rid = p.get("run_id") or "?"
        role = p.get("role") or rid
        elapsed = p.get("elapsed_s")
        status = p.get("status") or "running"
        reason = p.get("reason") or "运行过久"
        if elapsed is not None:
            return (
                f"- timeout【{role}】status={status}，已运行 {elapsed}s"
                f"（阈值 {p.get('threshold_s', '?')}s）：{reason}"
            )
        return f"- timeout【{role}】：{reason}"
    if ev.kind is CoordinationEventKind.ALL_COMPLETED:
        return (
            f"- all_completed：团队已全部结束（{p.get('completed', 0)}/"
            f"{p.get('total', session.total_workers)}）。请做最终合成并收口。"
        )
    if ev.kind is CoordinationEventKind.BOUNDARY_YIELD:
        return (
            f"- boundary_yield（{p.get('reason') or '?'}）：计划在波边界让出——"
            f"{p.get('brief') or '请用 replan 续跑或收口'}。"
        )
    return f"- {ev.kind.value}：{p}"


def blurb_from_state(state: object) -> str:
    """Best-effort one-line blurb; accepts RunState or falls back."""
    try:
        from agentcore.runtime.runs.types import RunState

        if isinstance(state, RunState):
            return worker_output_blurb(state)
    except Exception:  # noqa: BLE001
        pass
    content = getattr(state, "content", None)
    if isinstance(content, str) and content.strip():
        return content.strip().splitlines()[0][:80]
    return "（无摘要）"
