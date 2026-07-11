"""User-interaction SSE event factories (approval / checkpoint / plan_review / escalation)."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.checkpoints import AskCheckpointIntent
from agentcore.runtime.events.types import EventType, SSEEvent


def approval_required(
    *,
    approval_id: str,
    conversation_id: str,
    tool_call_id: str,
    tool_name: str,
    arguments: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.APPROVAL_REQUIRED,
        payload={
            "approval_id": approval_id,
            "conversation_id": conversation_id,
            "tool_call_id": tool_call_id,
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def delegation_authorization_required(
    *,
    authorization_id: str,
    conversation_id: str,
    execution_id: str,
    workers: list[dict[str, str]],
    tools: list[str],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DELEGATION_AUTHORIZATION_REQUIRED,
        payload={
            "authorization_id": authorization_id,
            "conversation_id": conversation_id,
            "execution_id": execution_id,
            "workers": workers,
            "tools": tools,
        },
    )


def delegation_authorization_resolved(
    *,
    authorization_id: str,
    execution_id: str,
    decision: str,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DELEGATION_AUTHORIZATION_RESOLVED,
        payload={
            "authorization_id": authorization_id,
            "execution_id": execution_id,
            "decision": decision,
        },
    )


def approval_resolved(*, approval_id: str, tool_call_id: str, decision: str) -> SSEEvent:
    return SSEEvent(
        type=EventType.APPROVAL_RESOLVED,
        payload={
            "approval_id": approval_id,
            "tool_call_id": tool_call_id,
            "decision": decision,
        },
    )


def checkpoint_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    question: str,
    context: str = "",
    assumptions: list[dict[str, Any]] | None = None,
    questions: list[dict[str, Any]] | None = None,
    style_options: list[dict[str, Any]] | None = None,
    intent: AskCheckpointIntent | None = None,
) -> SSEEvent:
    payload: dict[str, Any] = {
        "checkpoint_id": checkpoint_id,
        "conversation_id": conversation_id,
        "question": question,
        "context": context,
        "assumptions": assumptions or [],
        "questions": questions or [],
        "style_options": style_options or [],
    }
    if intent is not None:
        payload["intent"] = intent
    return SSEEvent(type=EventType.CHECKPOINT_REQUIRED, payload=payload)


def question_posted(
    *,
    ask_id: str,
    conversation_id: str,
    question: str,
    context: str = "",
    assumptions: list[dict[str, Any]] | None = None,
    questions: list[dict[str, Any]] | None = None,
    style_options: list[dict[str, Any]] | None = None,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.QUESTION_POSTED,
        payload={
            "ask_id": ask_id,
            "conversation_id": conversation_id,
            "question": question,
            "context": context,
            "assumptions": assumptions or [],
            "questions": questions or [],
            "style_options": style_options or [],
        },
    )


def checkpoint_resolved(
    *, checkpoint_id: str, decision: str, note: str = "", selected: list[str] | None = None
) -> SSEEvent:
    return SSEEvent(
        type=EventType.CHECKPOINT_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
            "selected": selected or [],
        },
    )


def plan_review_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    steps: list[dict[str, Any]],
    pending: list[dict[str, Any]],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.PLAN_REVIEW_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "steps": steps,
            "pending": pending,
        },
    )


def plan_review_resolved(*, checkpoint_id: str, decision: str, note: str = "") -> SSEEvent:
    return SSEEvent(
        type=EventType.PLAN_REVIEW_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
        },
    )


def team_preview_required(
    *,
    checkpoint_id: str,
    conversation_id: str,
    workers: list[dict[str, Any]],
) -> SSEEvent:
    """首波启动前的团队薄预览 gate（角色 / 任务摘要 / 依赖 / 是否辩论）。"""
    return SSEEvent(
        type=EventType.TEAM_PREVIEW_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "workers": workers,
        },
    )


def team_preview_resolved(*, checkpoint_id: str, decision: str, note: str = "") -> SSEEvent:
    return SSEEvent(
        type=EventType.TEAM_PREVIEW_RESOLVED,
        payload={
            "checkpoint_id": checkpoint_id,
            "decision": decision,
            "note": note,
        },
    )


def escalation_required(
    run_id: str,
    agent_id: str,
    *,
    escalation_id: str,
    question: str,
    assumption: str,
    questions: list[dict[str, Any]] | None = None,
    kind: str = "normal",
    awaiting: str = "user",
) -> SSEEvent:
    """``question`` is the worker's headline ask; ``questions`` is the optional
    structured-fork list (同 ask_user 的 questions) the card renders as choice/text so
    the user one-taps a decision instead of free-typing. Journaled, so the structured
    prompt replays inline on reload. ``kind`` is the escalate taxonomy
    (normal / scope / dep), orthogonal to blocking. ``awaiting`` is ``user`` (经典可答卡)
    or ``ceo`` (协调模式等主管仲裁，初始不作为用户可答卡)."""
    who = awaiting if awaiting in ("user", "ceo") else "user"
    return SSEEvent(
        type=EventType.ESCALATION_REQUIRED,
        payload={
            "escalation_id": escalation_id,
            "run_id": run_id,
            "agent_id": agent_id,
            "question": question,
            "assumption": assumption,
            "questions": questions or [],
            "kind": kind if kind in ("normal", "scope", "dep") else "normal",
            "awaiting": who,
        },
    )


def escalation_resolved(
    run_id: str,
    agent_id: str,
    *,
    escalation_id: str,
    status: str,
    answer: str,
    arbitrated_by: str | None = None,
    via_user: bool | None = None,
) -> SSEEvent:
    # Wire status is resolved | assumed | timed_out | orphaned.
    if status not in ("resolved", "assumed", "timed_out", "orphaned"):
        status = "timed_out"
    payload: dict[str, Any] = {
        "escalation_id": escalation_id,
        "run_id": run_id,
        "agent_id": agent_id,
        "status": status,
        "answer": answer,
    }
    if arbitrated_by in ("user", "ceo"):
        payload["arbitrated_by"] = arbitrated_by
    if via_user is not None and arbitrated_by == "ceo":
        payload["via_user"] = bool(via_user)
    return SSEEvent(
        type=EventType.ESCALATION_RESOLVED,
        payload=payload,
    )


def debate_round_decision_required(
    *,
    execution_id: str,
    moderator_run_id: str,
    decision_id: str,
    round_no: int,
    focus: str,
    summary: str,
    converged: bool,
    rationale: str = "",
) -> SSEEvent:
    """交互式逐轮辩论：主持人在一轮边界挂起等用户「继续辩 / 加角度 / 够了出结论」。

    ``decision_id`` 是 resolve 端点的交互 id（前端 POST 用户的选择回它）；``converged`` /
    ``rationale`` 是裁判对本轮的判读（卡片把它作为默认建议高亮）。Transport-only liveliness：
    NOT journaled——耐久记录是最终 ``debate_result``（用户的选择体现在实际发生的轮次 /
    stop_reason），重载据其重建，故本卡不进 journal / conformance（与 ``debate_round`` 同辙）。
    """
    return SSEEvent(
        type=EventType.DEBATE_ROUND_DECISION_REQUIRED,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            "decision_id": decision_id,
            "round_no": round_no,
            "focus": focus,
            "summary": summary,
            "converged": converged,
            "rationale": rationale,
        },
    )


def debate_round_decision_resolved(
    *,
    execution_id: str,
    moderator_run_id: str,
    decision_id: str,
    decision: str,
    focus: str = "",
) -> SSEEvent:
    """交互式逐轮辩论：上条决策的结算。``decision`` ∈ ``continue`` / ``conclude`` / ``timeout``
    / ``orphaned``；``focus`` 是用户「加角度」给的下一轮议题（仅 continue 且非空时有值）。"""
    return SSEEvent(
        type=EventType.DEBATE_ROUND_DECISION_RESOLVED,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            "decision_id": decision_id,
            "decision": decision,
            "focus": focus,
        },
    )


def interaction_orphaned(*, interaction_id: str, kind: str) -> SSEEvent:
    """热路 pending 交互失效。``kind`` ∈ approval / delegation_authorization / escalation / debate_round。"""
    return SSEEvent(
        type=EventType.INTERACTION_ORPHANED,
        payload={"interaction_id": interaction_id, "kind": kind},
    )
