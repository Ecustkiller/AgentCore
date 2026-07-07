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
    # 工具执行阶段进度（联网搜索前端展示优化）: a running tool reports a coarse EXECUTION phase
    # between tool_use_start and tool_use_end — distinct from TOOL_PROGRESS (which means the
    # LLM is still streaming the call's ARGUMENTS). web_search emits querying/queued/fallback
    # so the waiting UI shows a live, honest state instead of a dead spinner. Transport-only
    # liveliness (like TOOL_PROGRESS): never journaled, never in the process timeline / judge
    # state — a reloaded turn's tools are already done, so it only rides the live stream.
    TOOL_USE_PROGRESS = "tool_use_progress"
    TOOL_USE_END = "tool_use_end"
    MESSAGE_END = "message_end"
    ERROR = "error"
    TITLE_GENERATED = "title_generated"
    # CEO→用户「下一步推荐」(下一步推荐): 2-4 个可点选的快捷追问，回合收尾后由一次 World B
    # 窄任务生成、附到刚完成的助手消息下。与 title_generated 同属「回合后元信息」——不进
    # 判定态（ProjectedTurn），三端 fold 一律 no-op。持久化上是 DERIVED（处置见
    # events/disposition.py）：与孪生 title 一致回写 Message.followups 列，reload 重现 chips
    # （非 journal allow-list、故不进 turn_journal）。
    FOLLOWUPS_GENERATED = "followups_generated"
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
    # AI 协作白板 (AI协作白板.md §六 M2): a transport-only client-tool request — the
    # server asks the bound desktop to apply structured board ops to the open whiteboard
    # canvas and report back. Like WORKSPACE_OP_REQUIRED it is NOT journaled (it is a
    # request/response exchange, not turn content), so it stays out of the journal sets.
    BOARD_OP_REQUIRED = "board_op_required"
    # AI 协作白板 (AI协作白板.md §九): transport-only client-tool request — the server asks the
    # bound desktop to rasterize a subset of board elements (手绘 / 截图) to a PNG and report it
    # back so the vision reader can read it. Like BOARD_OP_REQUIRED it is NOT journaled (a
    # request/response exchange, not turn content), so it stays out of the journal sets.
    BOARD_READ_REQUIRED = "board_read_required"
    HANDOFF_SNAPSHOT_DONE = "handoff_snapshot_done"
    HANDOFF_JOB_STARTED = "handoff_job_started"
    HANDOFF_APPLY_DONE = "handoff_apply_done"
    RUN_PLAN = "run_plan"
    RUN_STARTED = "run_started"
    RUN_CONTEXT = "run_context"
    RUN_OUTPUT_DELTA = "run_output_delta"
    RUN_OUTPUT_RESET = "run_output_reset"
    RUN_REASONING_DELTA = "run_reasoning_delta"
    RUN_COMPLETED = "run_completed"
    RUN_FAILED = "run_failed"
    RUN_PROGRESS = "run_progress"
    RUN_TOOL_PROGRESS = "run_tool_progress"
    BATCH_METRICS = "batch_metrics"
    RUN_ESCALATION = "run_escalation"
    ESCALATION_REQUIRED = "escalation_required"
    ESCALATION_RESOLVED = "escalation_resolved"
    # 团队便签墙 (§2.2 通): a worker pinned a short note (我定了 X / 提个醒 Y) to the batch
    # note wall for its concurrent siblings. Journaled (it rides a delegate turn alongside
    # RUN_PLAN, a surface type), so the team-notes panel replays on reload; folded onto the
    # ProjectedTurn so both ends render it (conformance-visible, unlike transport-only board ops).
    TEAM_NOTE_POSTED = "team_note_posted"
    DEBATE_RESULT = "debate_result"
    DEBATE_ROUND_STARTED = "debate_round_started"
    DEBATE_ROUND = "debate_round"
    DEBATE_ROUND_DECISION_REQUIRED = "debate_round_decision_required"
    DEBATE_ROUND_DECISION_RESOLVED = "debate_round_decision_resolved"
    # BYOK soft gate (开放主流AI模型接入 §4.5): preflight hint when probe says the
    # user's model may lack tool calling. Transport-only — not journaled.
    TURN_WARNING = "turn_warning"
    # AI Town simulation (M1): tick lifecycle + agent snapshots. Persisted in sim_event,
    # not turn_journal — EPHEMERAL disposition (see disposition.py).
    SIM_TICK_STARTED = "sim.tick_started"
    SIM_TICK_ENDED = "sim.tick_ended"
    SIM_AGENT_ACTION = "sim.agent_action"
    SIM_AGENT_STATE = "sim.agent_state"
    SIM_INTERACTION = "sim.interaction"
    SIM_WORLD_EVENT = "sim.world_event"
    SIM_TICK_FRAME = "sim.tick_frame"


class FinishReason(StrEnum):
    END_TURN = "end_turn"
    MAX_ROUNDS = "max_rounds"
    DEGRADED = "degraded"
    UNPRODUCTIVE = "unproductive"
    ERROR = "error"
    CANCELLED = "cancelled"
    # 挂起即收口 (②): the turn ended NOT because it finished, but because it hit a durable
    # checkpoint (ask_user blocking / plan_review) and finalized in place — its frame +
    # journal are persisted and it awaits ``POST .../resume``. Distinct from END_TURN (the
    # turn is NOT done) and CANCELLED (no error / no abort): the client renders the stream's
    # close as the single resume card.
    PAUSED = "paused"


@dataclass
class SSEEvent:
    """A single event to be sent over the SSE stream."""

    type: EventType
    payload: dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
