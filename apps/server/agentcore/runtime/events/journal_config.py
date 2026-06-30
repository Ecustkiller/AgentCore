"""Journal / history / process constants shared by EventSink."""

from __future__ import annotations

from agentcore.runtime.events.types import EventType

_JOURNAL_EVENT_TYPES = frozenset(
    {
        EventType.RUN_PLAN,
        EventType.RUN_STARTED,
        EventType.RUN_CONTEXT,
        EventType.RUN_COMPLETED,
        EventType.RUN_FAILED,
        EventType.RUN_PROGRESS,
        # 调度埋点量化 (深层诊断指标, 前端UX设计.md §十): journaled so the run-detail 诊断信息
        # replays the scheduler snapshot on reload. Like PLAN_REVISED it only fires inside a
        # delegate turn (alongside RUN_PLAN, a surface type), so it needs no _JOURNAL_SURFACE_TYPES
        # entry to gate journal persistence.
        EventType.BATCH_METRICS,
        EventType.DEBATE_RESULT,
        EventType.TOOL_USE_START,
        EventType.TOOL_USE_END,
        EventType.CHECKPOINT_REQUIRED,
        EventType.CHECKPOINT_RESOLVED,
        EventType.QUESTION_POSTED,
        EventType.PLAN_REVIEW_REQUIRED,
        EventType.PLAN_REVIEW_RESOLVED,
        # 自主再绑定的「计划已调整」轻痕迹 (设计 §7.2): journaled so the trace replays on
        # reload. It only ever fires inside a delegate turn (alongside RUN_PLAN, a surface
        # type), so it needs no entry in _JOURNAL_SURFACE_TYPES to gate journal persistence.
        EventType.PLAN_REVISED,
        EventType.ESCALATION_REQUIRED,
        EventType.ESCALATION_RESOLVED,
        # 团队便签墙 (§2.2 通): journaled so the team-notes panel replays on reload. Like
        # PLAN_REVISED / BATCH_METRICS it only fires inside a delegate turn (alongside
        # RUN_PLAN, a surface type), so it needs no _JOURNAL_SURFACE_TYPES entry to gate
        # journal persistence.
        EventType.TEAM_NOTE_POSTED,
    }
)

_JOURNAL_SURFACE_TYPES = frozenset(
    {
        EventType.RUN_PLAN.value,
        EventType.CHECKPOINT_REQUIRED.value,
        EventType.QUESTION_POSTED.value,
        EventType.PLAN_REVIEW_REQUIRED.value,
    }
)

_PROCESS_RESULT_CAP = 8000

_HISTORY_SKIP_TYPES = frozenset(
    {
        EventType.TOOL_PROGRESS,
        EventType.RUN_TOOL_PROGRESS,
        EventType.MESSAGE_END,
        EventType.ERROR,
        EventType.WORKSPACE_OP_REQUIRED,
        EventType.HANDOFF_SNAPSHOT_DONE,
        EventType.HANDOFF_JOB_STARTED,
        EventType.HANDOFF_APPLY_DONE,
    }
)

_HISTORY_COALESCE_TURN = frozenset({EventType.CONTENT_DELTA, EventType.REASONING_DELTA})

_HISTORY_COALESCE_RUN = frozenset({EventType.RUN_OUTPUT_DELTA, EventType.RUN_REASONING_DELTA})
