"""Debate SSE event factories (result / round)."""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.types import EventType, SSEEvent


def debate_result(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_RESULT,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )


def debate_round_started(
    *,
    execution_id: str,
    moderator_run_id: str,
    round_no: int,
    focus: str,
    cross_exam_enabled: bool = False,
    opening: str = "",
    form: str = "",
) -> SSEEvent:
    payload: dict = {
        "execution_id": execution_id,
        "moderator_run_id": moderator_run_id,
        "round_no": round_no,
        "focus": focus,
        "cross_exam_enabled": cross_exam_enabled,
        "opening": opening,
    }
    if form:
        payload["form"] = form
    return SSEEvent(
        type=EventType.DEBATE_ROUND_STARTED,
        payload=payload,
    )


def debate_round(
    *,
    execution_id: str,
    moderator_run_id: str,
    payload: dict[str, Any],
) -> SSEEvent:
    return SSEEvent(
        type=EventType.DEBATE_ROUND,
        payload={
            "execution_id": execution_id,
            "moderator_run_id": moderator_run_id,
            **payload,
        },
    )
