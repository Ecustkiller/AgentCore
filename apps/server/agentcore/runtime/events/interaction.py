"""User-interaction SSE event factories (approval / checkpoint / plan_review / escalation)."""

from __future__ import annotations

from typing import Any

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
) -> SSEEvent:
    return SSEEvent(
        type=EventType.CHECKPOINT_REQUIRED,
        payload={
            "checkpoint_id": checkpoint_id,
            "conversation_id": conversation_id,
            "question": question,
            "context": context,
            "assumptions": assumptions or [],
            "questions": questions or [],
            "style_options": style_options or [],
        },
    )


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


def escalation_required(
    run_id: str,
    agent_id: str,
    *,
    escalation_id: str,
    question: str,
    assumption: str,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.ESCALATION_REQUIRED,
        payload={
            "escalation_id": escalation_id,
            "run_id": run_id,
            "agent_id": agent_id,
            "question": question,
            "assumption": assumption,
        },
    )


def escalation_resolved(
    run_id: str,
    agent_id: str,
    *,
    escalation_id: str,
    status: str,
    answer: str,
) -> SSEEvent:
    return SSEEvent(
        type=EventType.ESCALATION_RESOLVED,
        payload={
            "escalation_id": escalation_id,
            "run_id": run_id,
            "agent_id": agent_id,
            "status": status,
            "answer": answer,
        },
    )
