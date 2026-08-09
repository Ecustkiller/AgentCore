"""Debate SSE event factories (result / round / pretrial)."""

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


def debate_pretrial_started(**payload: Any) -> SSEEvent:
    """庭前取证开场（fast 档亦可带 skip_reason 秒过）。"""
    return SSEEvent(type=EventType.DEBATE_PRETRIAL_STARTED, payload=dict(payload))


def debate_pretrial_orders(**payload: Any) -> SSEEvent:
    """庭前准备摘要（Evidence Pack / 空订单 + 外证计划）。"""
    return SSEEvent(type=EventType.DEBATE_PRETRIAL_ORDERS, payload=dict(payload))


def debate_pretrial_completed(**payload: Any) -> SSEEvent:
    """庭前收口（done / skipped / degraded + ledger delta）。"""
    return SSEEvent(type=EventType.DEBATE_PRETRIAL_COMPLETED, payload=dict(payload))
