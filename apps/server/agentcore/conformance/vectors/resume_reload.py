"""Conformance vectors — resumed reload == live (turn_paused batch 8).

``plan_review`` resume scenes retired with the kind. These two keep the same
content-concat / G6 reset-reinject shape on the live ask_user cold path.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import (
    FinishReason,
    SSEEvent,
    checkpoint_required,
    checkpoint_resolved,
    content_delta,
    content_reset,
    message_end,
    message_start,
    run_completed,
    run_plan,
    run_started,
)

from ._common import _CONV, _COST, _USAGE

_QUESTION = "方案已就绪，继续落地吗？"

_AGENTS = [
    {"id": "w1", "role": "调研", "thinking": True},
    {"id": "w2", "role": "执行", "thinking": True},
]
_PLAN_RUNS = [
    {"id": "r1", "agent_id": "w1", "task": "出方案", "depends_on": []},
    {"id": "r2", "agent_id": "w2", "task": "落地", "depends_on": ["r1"]},
]


def _through_ask_user_continue() -> list[SSEEvent]:
    return [
        message_start("m1", conversation_id=_CONV),
        content_delta("阶段成果如下。"),
        run_plan(
            execution_id="exec1",
            plan_type="multi_agent",
            task_summary="分阶段",
            agents=_AGENTS,
            runs=_PLAN_RUNS,
        ),
        run_started("r1", "w1"),
        run_completed(
            "r1",
            "w1",
            output_summary="方案就绪",
            duration_ms=900,
            role="member",
            model="deepseek-v4-flash",
            usage=_USAGE,
            cost=_COST,
        ),
        checkpoint_required(
            checkpoint_id="cp1",
            conversation_id=_CONV,
            question=_QUESTION,
            intent="decision",
        ),
        checkpoint_resolved(checkpoint_id="cp1", decision="continue"),
    ]


def _resume_content_continuity() -> list[SSEEvent]:
    """挂起恢复：ask_user 前后正文续拼（resumed reload == live）。"""
    return [
        *_through_ask_user_continue(),
        content_delta("按确认继续交付。"),
        message_end(
            FinishReason.END_TURN, input_tokens=3000, output_tokens=400, cost=_COST
        ),
    ]


def _resume_content_reset_reinject() -> list[SSEEvent]:
    """挂起恢复：content_reset 后重灌 pre_pause delta 再重写（G6）。"""
    return [
        *_through_ask_user_continue(),
        content_delta("这一版将被核验回炉丢弃。"),
        content_reset("finish_guard"),
        content_delta("阶段成果如下。\n\n"),
        content_delta("重写后的交付正文。"),
        message_end(
            FinishReason.END_TURN, input_tokens=3200, output_tokens=420, cost=_COST
        ),
    ]


VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "resume_content_continuity": (
        "挂起恢复：ask_user 前后正文续拼（resumed reload == live）",
        _resume_content_continuity,
    ),
    "resume_content_reset_reinject": (
        "挂起恢复：content_reset 后重灌 pre_pause delta 再重写（G6）",
        _resume_content_reset_reinject,
    ),
}
