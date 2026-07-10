"""Multi-agent run SSE payload wire models (factories: ``runtime/events/run.py``)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

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
    revision: int | None = absent()
    stance: Stance | None = absent()
    group: str | None = absent()
    round: int | None = absent()
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
    "revision",
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
    run_id: str
    agent_id: str
    question: str
    assumption: str
    blocking: bool
    kind: EscalationKind | None = absent()


class RunIntakePayload(WirePayload):
    run_id: str
    agent_id: str
    complexity: Literal["simple", "moderate", "complex"]
    strategy: Literal["direct_execute", "needs_tools", "needs_research"]
    token_budget: int
    rationale: str | None = absent()
    signals: list[str] | None = absent()


class RunEscalationGatePayload(WirePayload):
    run_id: str
    agent_id: str
    layer: Literal["execution", "scheme"]
    action: Literal["continue", "escalate"]
    signals: list[dict[str, Any]]


class RunSplitAssessedPayload(WirePayload):
    run_id: str
    agent_id: str
    should_split: bool
    rationale: str | None = absent()
    triggers: list[str] | None = absent()
    subtask_count: int | None = absent()
    subtasks: list[dict[str, Any]] | None = absent()
    pressure: dict[str, Any] | None = absent()


class RunSubworkerStartedPayload(WirePayload):
    run_id: str
    agent_id: str
    subworker_id: str
    goal: str
    token_budget: int | None = absent()
    index: int | None = absent()
    total: int | None = absent()
    can_split: bool | None = absent()
    depth: int | None = absent()


class RunSubworkerCompletedPayload(WirePayload):
    run_id: str
    agent_id: str
    subworker_id: str
    success: bool
    summary: str | None = absent()
    artifact_refs: list[str] | None = absent()
    failure: str | None = absent()
    side_effects: list[str] | None = absent()
    tokens_used: int | None = absent()
    rounds: int | None = absent()
    index: int | None = absent()
    total: int | None = absent()
    fold_summary: str | None = absent()


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
from agentcore.runtime.events.payloads.shared import CostBreakdown, RunDebrief, UsageBreakdown  # noqa: E402,F401
from agentcore.runtime.runs.types import RunKind as RunKind  # noqa: F401
