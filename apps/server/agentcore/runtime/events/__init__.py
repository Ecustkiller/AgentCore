"""SSE event type definitions and EventSink.

Events flow from the engine → asyncio.Queue → SSE StreamingResponse → client.
The EventSink decouples execution from delivery (backpressure-safe).

→ 见设计: docs/03-AI核心/执行引擎架构设计.md §十八（事件流）
"""

from __future__ import annotations

from agentcore.runtime.events.chat import (
    citations_event,
    content_delta,
    content_reset,
    error_event,
    message_end,
    message_start,
    reasoning_delta,
    title_generated,
    tool_progress,
    tool_use_end,
    tool_use_start,
    turn_saved,
)
from agentcore.runtime.events.interaction import (
    approval_required,
    approval_resolved,
    checkpoint_required,
    checkpoint_resolved,
    debate_round_decision_required,
    debate_round_decision_resolved,
    escalation_required,
    escalation_resolved,
    plan_review_required,
    plan_review_resolved,
    question_posted,
)
from agentcore.runtime.events.journal_config import (
    _JOURNAL_EVENT_TYPES,
    _JOURNAL_SURFACE_TYPES,
)
from agentcore.runtime.events.run import (
    batch_metrics,
    debate_result,
    debate_round,
    debate_round_started,
    escalation_raised,
    plan_revised,
    run_completed,
    run_context,
    run_failed,
    run_output_delta,
    run_output_reset,
    run_plan,
    run_progress,
    run_reasoning_delta,
    run_started,
    run_tool_progress,
)
from agentcore.runtime.events.sink import EventSink
from agentcore.runtime.events.types import EventType, FinishReason, SSEEvent
from agentcore.runtime.events.workspace import (
    handoff_apply_done,
    handoff_job_started,
    handoff_snapshot_done,
    workspace_op_required,
    workspace_promoted,
)

__all__ = [
    "EventType",
    "FinishReason",
    "SSEEvent",
    "EventSink",
    "_JOURNAL_EVENT_TYPES",
    "_JOURNAL_SURFACE_TYPES",
    "message_start",
    "content_delta",
    "content_reset",
    "reasoning_delta",
    "tool_progress",
    "tool_use_start",
    "tool_use_end",
    "citations_event",
    "approval_required",
    "approval_resolved",
    "checkpoint_required",
    "checkpoint_resolved",
    "question_posted",
    "plan_review_required",
    "plan_review_resolved",
    "workspace_op_required",
    "workspace_promoted",
    "handoff_snapshot_done",
    "handoff_job_started",
    "handoff_apply_done",
    "message_end",
    "error_event",
    "title_generated",
    "turn_saved",
    "run_plan",
    "plan_revised",
    "run_started",
    "run_context",
    "run_output_delta",
    "run_output_reset",
    "run_reasoning_delta",
    "run_tool_progress",
    "escalation_raised",
    "escalation_required",
    "escalation_resolved",
    "run_completed",
    "run_failed",
    "run_progress",
    "batch_metrics",
    "debate_result",
    "debate_round_started",
    "debate_round",
    "debate_round_decision_required",
    "debate_round_decision_resolved",
]
