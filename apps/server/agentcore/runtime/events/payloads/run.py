"""Multi-agent run SSE payload wire models (factories: ``runtime/events/run.py``)."""

from __future__ import annotations

from typing import Any, Literal

from agentcore.runtime.events.payloads._base import WirePayload, absent
from agentcore.runtime.events.payloads.shared import CostBreakdown, RunDebrief, UsageBreakdown
from agentcore.runtime.runs.types import RunKind

Stance = Literal["pro", "con"]
EscalationKind = Literal["normal", "scope", "dep"]
PlanRevisionKind = Literal["bind", "steer"]


class PlanRevision(WirePayload):
    run_id: str
    kind: PlanRevisionKind


class PlanRevisedPayload(WirePayload):
    execution_id: str
    revisions: list[PlanRevision]


class PlanAgentPayload(WirePayload):
    id: str
    role: str
    model_preference: Literal["fast", "strong"]
    thinking: bool
    reasoning_effort: Literal["high", "max", "low"] | None = None


class RunPlanRunEntry(WirePayload):
    id: str
    agent_id: str
    task: str
    depends_on: list[str]
    parent_run_id: str | None = absent()
    kind: RunKind | None = absent(ts_type="RunKind")
    stance: Stance | None = absent()
    group: str | None = absent()
    round: int | None = absent()
    replaces_run_id: str | None = absent()


class RunPlanPayload(WirePayload):
    execution_id: str
    plan_type: Literal["single_agent", "multi_agent", "debate"]
    task_summary: str
    agents: list[PlanAgentPayload]
    runs: list[RunPlanRunEntry]


class RunStartedPayload(WirePayload):
    run_id: str
    agent_id: str
    parent_run_id: str | None
    kind: RunKind
    # 同人续派 / 热修 / 辩论续写：恒指现场根（RunSession 键）；星型，前端铺链。
    continues_run_id: str | None = absent()
    stance: Stance | None = absent()
    group: str | None = absent()
    round: int | None = absent()
    # 辩论续写语义方 key（质询 / 结辩 / 续轮）；缺字段（老 journal）→ 前端按 stance / sides 回退。
    side_key: str | None = absent()
    replaces_run_id: str | None = absent()


ContextChannel = Literal[
    "system",
    "history",
    "request",
    "team_position",
    "dependency",
    "workspace",
    "task",
    "deliverable",
    "team_brief",
    "steer",
    "team_result",
    "round_focus",
    "opponent",
    "challenge",
    "interjection",
    "continuation",
    "cross_exam",
    "closing",
]
ContextFidelity = Literal["", "pointer", "summarize", "pass_through"]


class ContextBlockWire(WirePayload):
    channel: ContextChannel
    heading: str
    body: str
    chars: int
    truncated: bool
    source_role: str
    source_run_id: str
    fidelity: ContextFidelity
    files: list[str]


class RunContextPayload(WirePayload):
    run_id: str
    agent_id: str
    blocks: list[ContextBlockWire]


class RunOutputDeltaPayload(WirePayload):
    run_id: str
    agent_id: str
    delta: str


class RunOutputResetPayload(WirePayload):
    run_id: str
    agent_id: str


class RunReasoningDeltaPayload(WirePayload):
    run_id: str
    agent_id: str
    delta: str


class RunToolProgressPayload(WirePayload):
    run_id: str
    agent_id: str
    tool_name: str
    chars: int


class RunEscalationPayload(WirePayload):
    """升级实时可见 (非阻塞 raised): a worker flagged a decision/blocker and kept working.

    JOURNALED (DURABLE, 统一时间线二期 D6): ``escalation_id`` keys the raised 轻行's
    timeline marker (幂等去重 on attach replay) and lets the raised row + node ⚠️ badge
    reload — the event base is now level with ``escalation_required``.
    """

    escalation_id: str
    run_id: str
    agent_id: str
    question: str
    assumption: str
    blocking: bool
    kind: EscalationKind | None = absent()


class RunEscalationGatePayload(WirePayload):
    run_id: str
    agent_id: str
    layer: Literal["execution", "scheme"]
    action: Literal["continue", "escalate"]
    signals: list[dict[str, Any]]


class TeamNotePostedPayload(WirePayload):
    execution_id: str
    note_id: str
    run_id: str
    agent_id: str
    role: str
    kind: Literal["decision", "heads_up", "claim"]
    text: str
    ts: float
    supersedes: str | None = absent()
    supersede_mode: Literal["update", "void"] | None = absent()
    source: Literal["ceo", "worker", "inherited"] | None = absent()


class TeamSynthesisWorkerPreview(WirePayload):
    run_id: str
    role: str
    status: Literal["pending", "completed", "failed", "cancelled"]
    summary: str


class TeamSynthesisPreviewPayload(WirePayload):
    execution_id: str
    completed: int
    total: int
    headline: str
    text: str
    workers: list[TeamSynthesisWorkerPreview]
    in_progress: bool


class UserInterjectionPayload(WirePayload):
    """Mid-flight user message into a live coordination turn (CEO routes)."""

    interjection_id: str
    execution_id: str
    content: str
    status: Literal["delivered", "queued"]
    note: str | None = absent()


class RunCompletedPayload(WirePayload):
    run_id: str
    agent_id: str
    output_summary: str
    duration_ms: int
    role: str
    model: str
    usage: UsageBreakdown
    cost: CostBreakdown
    debrief: RunDebrief | None = absent()
    output_files: list[str] | None = absent()


class RunFailedPayload(WirePayload):
    run_id: str
    agent_id: str
    error: str
    debrief: RunDebrief | None = absent()


class RunCancelledPayload(WirePayload):
    run_id: str
    agent_id: str
    reason: Literal["redirect", "stop"]


class RunSkippedPayload(WirePayload):
    run_id: str
    agent_id: str
    reason: Literal["cascade", "abort"]


class RunProgressPayload(WirePayload):
    completed: int
    total: int


class NodeTimingPayload(WirePayload):
    run_id: str
    start_ms: int
    end_ms: int
    outcome: str


class BatchMetricsPayload(WirePayload):
    execution_id: str
    nodes: int
    width: int
    peak_running: int
    wall_ms: int
    busy_ms: int
    slot_starved: int
    completed: int
    failed: int
    skipped: int
    cancelled: int
    bind_boundaries: int
    scope_boundaries: int
    checkpoint_boundaries: int
    escalations: int
    scope_escalations: int
    timeline: list[NodeTimingPayload]


# Registry alias (events.ts names this inline run-plan row type).
RunPlanNode = RunPlanRunEntry

# Re-export shared leaf types referenced by ``payloads/__init__.py`` TS_EXPORTS.
