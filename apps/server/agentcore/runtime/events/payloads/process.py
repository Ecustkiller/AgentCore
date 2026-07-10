"""ProcessStep — one step in a turn's 思考·正文·工具·协作 inline timeline (统一团队时间线).

Not an event payload itself: the shared wire-shaped leaf carried verbatim inside
`ProjectedTurn.messages[*].process` and the REST `RunsPayload.process`. The first three
kinds are the CEO bubble's own narrative; the remaining kinds are POSITIONAL MARKERS —
zero-width anchors fixing WHERE a non-text turn element renders (payload looked up from
the turn's side channels by id). Emitted to TS as one inline discriminated union.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from agentcore.runtime.events.payloads._base import WirePayload, absent


class ProcessReasoningStep(WirePayload):
    kind: Literal["reasoning"]
    text: str


class ProcessContentStep(WirePayload):
    kind: Literal["content"]
    text: str


class ProcessReworkStep(WirePayload):
    """交付前核验回炉轻痕迹：`content_reset` 折入时间线的 chip，不堆被弃全文。"""

    kind: Literal["rework"]


class ProcessToolStep(WirePayload):
    kind: Literal["tool"]
    id: str
    tool_name: str
    arguments: dict[str, Any]
    result: str | None
    status: Literal["running", "success", "error"]
    display: dict[str, Any] | None = Field(
        default=None, json_schema_extra={"ts_type": "ToolDisplay"}
    )
    phase: str | None = absent(
        "工具执行阶段进度: the running tool's latest coarse phase from `tool_use_progress`. "
        "LIVE-ONLY ephemeral — never journaled, never in the conformance ProjectedTurn; "
        "meaningful only while status === 'running'.",
        ts_type="ToolPhase",
    )


class ProcessTeamStep(WirePayload):
    """The multi-agent collaboration graph slot (emitted at the turn's first `run_plan`)."""

    kind: Literal["team"]
    execution_id: str


class ProcessCheckpointStep(WirePayload):
    kind: Literal["checkpoint"]
    checkpoint_id: str


class ProcessAskStep(WirePayload):
    kind: Literal["ask"]
    ask_id: str


class ProcessPlanReviewStep(WirePayload):
    kind: Literal["plan_review"]
    checkpoint_id: str


class ProcessTeamPreviewStep(WirePayload):
    kind: Literal["team_preview"]
    checkpoint_id: str


PROCESS_STEP_MEMBERS: tuple[type[WirePayload], ...] = (
    ProcessReasoningStep,
    ProcessContentStep,
    ProcessReworkStep,
    ProcessToolStep,
    ProcessTeamStep,
    ProcessCheckpointStep,
    ProcessAskStep,
    ProcessPlanReviewStep,
    ProcessTeamPreviewStep,
)
