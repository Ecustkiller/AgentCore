"""SSE event type definitions and the SSEEvent dataclass."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class EventType(StrEnum):
    MESSAGE_START = "message_start"
    CONTENT_DELTA = "content_delta"
    CONTENT_RESET = "content_reset"
    REASONING_DELTA = "reasoning_delta"
    TOOL_PROGRESS = "tool_progress"
    TOOL_USE_START = "tool_use_start"
    TOOL_USE_END = "tool_use_end"
    MESSAGE_END = "message_end"
    ERROR = "error"
    TITLE_GENERATED = "title_generated"
    TURN_SAVED = "turn_saved"
    CITATIONS = "citations"
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_RESOLVED = "approval_resolved"
    CHECKPOINT_REQUIRED = "checkpoint_required"
    CHECKPOINT_RESOLVED = "checkpoint_resolved"
    QUESTION_POSTED = "question_posted"
    PLAN_REVIEW_REQUIRED = "plan_review_required"
    PLAN_REVIEW_RESOLVED = "plan_review_resolved"
    PLAN_REVISED = "plan_revised"
    WORKSPACE_OP_REQUIRED = "workspace_op_required"
    WORKSPACE_PROMOTED = "workspace_promoted"
    HANDOFF_SNAPSHOT_DONE = "handoff_snapshot_done"
    HANDOFF_JOB_STARTED = "handoff_job_started"
    HANDOFF_APPLY_DONE = "handoff_apply_done"
    RUN_PLAN = "run_plan"
    RUN_STARTED = "run_started"
    RUN_CONTEXT = "run_context"
    RUN_OUTPUT_DELTA = "run_output_delta"
    RUN_REASONING_DELTA = "run_reasoning_delta"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_PROGRESS = "run_progress"
    RUN_TOOL_PROGRESS = "run_tool_progress"
    BATCH_METRICS = "batch_metrics"
    RUN_ESCALATION = "run_escalation"
    ESCALATION_REQUIRED = "escalation_required"
    ESCALATION_RESOLVED = "escalation_resolved"
    DEBATE_RESULT = "debate_result"
    DEBATE_ROUND_STARTED = "debate_round_started"
    DEBATE_ROUND = "debate_round"


class FinishReason(StrEnum):
    END_TURN = "end_turn"
    MAX_ROUNDS = "max_rounds"
    DEGRADED = "degraded"
    UNPRODUCTIVE = "unproductive"
    ERROR = "error"
    CANCELLED = "cancelled"


@dataclass
class SSEEvent:
    """A single event to be sent over the SSE stream."""

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
