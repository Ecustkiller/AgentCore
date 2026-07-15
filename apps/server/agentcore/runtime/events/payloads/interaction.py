"""User-interaction SSE payload wire models (factories: ``runtime/events/interaction.py``).

Decision enums are reused from their runtime owners (``runtime/approvals.py`` /
``runtime/checkpoints.py``) so the wire contract and the gate logic share one source.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from agentcore.runtime.approvals import ApprovalDecision, DelegationAuthorizationDecision
from agentcore.runtime.checkpoints import AskCheckpointIntent, CheckpointDecision
from agentcore.runtime.events.payloads._base import WirePayload, absent
from agentcore.runtime.events.payloads.run import EscalationKind


class ApprovalRequiredPayload(WirePayload):
    approval_id: str
    conversation_id: str
    tool_call_id: str
    tool_name: str
    arguments: dict[str, Any]


class ApprovalResolvedPayload(WirePayload):
    approval_id: str
    tool_call_id: str
    decision: ApprovalDecision


class DelegationAuthorizationWorker(WirePayload):
    """One worker row on the delegation authorization card (role + task preview)."""

    role: str
    task: str


class DelegationAuthorizationRequiredPayload(WirePayload):
    """A delegate batch paused awaiting the user's delegation-level tool authorization
    (委派级授权). Medium-risk tools in `tools` are the grant scope."""

    authorization_id: str
    conversation_id: str
    execution_id: str
    workers: list[DelegationAuthorizationWorker]
    tools: list[str]


class DelegationAuthorizationResolvedPayload(WirePayload):
    authorization_id: str
    execution_id: str
    decision: DelegationAuthorizationDecision


class AskAssumption(WirePayload):
    id: str
    label: str
    value: str


class AskOption(WirePayload):
    """One selectable answer to a choice AskQuestion. `label` is both the displayed text
    and the value composed back into the answer; `recommended` is advisory highlight only
    (NOT a pre-selection). `action` marks an option that the desktop client fulfils with a
    native client action instead of a plain text answer (unknown/absent → plain option):
    `bind_local_folder` renders as a folder picker that binds the conversation workspace
    to the chosen local directory before resuming the turn;
    `grant_readonly_folder` renders as a folder picker that grants a session-scoped
    read-only mount under ``external/<alias>/`` (W3; does not change workspace binding)."""

    label: str
    detail: str | None = absent()
    recommended: bool | None = absent()
    action: Literal["bind_local_folder", "grant_readonly_folder"] | None = absent()


class AskQuestion(WirePayload):
    id: str
    prompt: str
    kind: Literal["choice", "text"]
    options: list[AskOption]
    multiple: bool
    default: str


class AskStyleOption(WirePayload):
    id: str
    label: str


class CheckpointRequiredPayload(WirePayload):
    """The CEO paused the turn on an ask_user checkpoint (blocking)."""

    checkpoint_id: str
    conversation_id: str
    question: str
    context: str
    assumptions: list[AskAssumption]
    questions: list[AskQuestion]
    style_options: list[AskStyleOption]
    intent: AskCheckpointIntent | None = absent(ts_type="CheckpointIntent")


class CheckpointResolvedPayload(WirePayload):
    checkpoint_id: str
    decision: CheckpointDecision
    note: str
    selected: list[str] | None = absent()


class QuestionPostedPayload(WirePayload):
    """A non-blocking ask the CEO posted (ask_user blocking=false): it already has a
    default and KEPT WORKING — no suspend, no resolve."""

    ask_id: str
    conversation_id: str
    question: str
    context: str
    assumptions: list[AskAssumption]
    questions: list[AskQuestion]
    style_options: list[AskStyleOption]


class PlanReviewStep(WirePayload):
    run_id: str
    role: str
    summary: str


class PlanReviewPending(WirePayload):
    run_id: str
    role: str


class PlanReviewRequiredPayload(WirePayload):
    checkpoint_id: str
    conversation_id: str
    steps: list[PlanReviewStep]
    pending: list[PlanReviewPending]


class PlanReviewResolvedPayload(WirePayload):
    checkpoint_id: str
    decision: CheckpointDecision
    note: str


class TeamPreviewWorker(WirePayload):
    """One upcoming worker row on the thin team-preview card (团队预审)."""

    run_id: str
    role: str
    task: str
    depends_on: list[str]
    debate: bool


class TeamPreviewSide(WirePayload):
    """One debate participant on the debate kickoff card."""

    key: str
    name: str
    stance: str
    is_subject: bool | None = absent()


class TeamPreviewRequiredPayload(WirePayload):
    """开工卡：计划预览 + 能力授权（两卡合一）。

    ``primitive`` discriminates ``delegate`` (workers 分工表) vs ``debate``
    (motion / sides / max_rounds). ``tools`` may be empty under full_auto /
    always_ask / debate read-only debaters.
    """

    checkpoint_id: str
    conversation_id: str
    workers: list[TeamPreviewWorker]
    tools: list[str] = Field(default_factory=list)
    primitive: Literal["delegate", "debate"] | None = absent(
        "编排原语判别；缺省按 delegate（旧 journal / 向量兼容）。"
    )
    motion: str | None = absent("辩论辩题；仅 primitive=debate。")
    form: str | None = absent("辩论形态 debate/red_team/roundtable。")
    sides: list[TeamPreviewSide] | None = absent("辩论各方立场。")
    max_rounds: int | None = absent("辩论轮次安全上限（预算展示）。")
    thorough: bool | None = absent("辩论认真辩透 vs 快速对碰。")


class TeamPreviewResolvedPayload(WirePayload):
    checkpoint_id: str
    decision: CheckpointDecision  # continue(=grant[+steer]) / per_call / adjust / stop / …
    note: str


class EscalationRequiredPayload(WirePayload):
    """阻塞式求决策 (escalate blocking=true): a delegated worker SUSPENDED itself awaiting
    a decision. JOURNALED (unlike the transport-only `run_escalation` banner); the
    turn never flips to `paused` (siblings keep running).

    ``awaiting``: ``user`` (经典路径，可答卡) or ``ceo`` (协调模式下等主管仲裁，初始不可答)。
    Absent on old journaled events → fold as ``user``.
    """

    escalation_id: str
    run_id: str
    agent_id: str
    question: str
    assumption: str
    questions: list[AskQuestion] | None = absent(
        "Structured forks (同 ask_user 的 questions). Absent on old journaled events "
        "(fold with `?? []`); empty for a free-text ask."
    )
    kind: EscalationKind | None = absent("旧流缺字段时前端按 `normal`。与 blocking 轴正交。")
    awaiting: Literal["user", "ceo"] | None = absent(
        "谁在仲裁：user=经典可答卡；ceo=协调模式等主管。旧流缺字段按 user。"
    )


class EscalationResolvedPayload(WirePayload):
    """阻塞式求决策 settlement. Emitted by the suspending tool's awaiter ONLY; journaled.

    ``status`` 三分（对 worker 回落假设的实现可共享，对外语义必须分开）：
    - ``resolved`` — 有裁决/答复（``answer`` 非空语义由调用方保证）
    - ``assumed`` — 用户或主管显式选了「按假设继续」
    - ``timed_out`` — 墙钟时限内未答复

    ``arbitrated_by`` / ``via_user`` annotate CEO 协调仲裁可见性（经典用户直答路径可缺省）。
    """

    escalation_id: str
    run_id: str
    agent_id: str
    status: Literal["resolved", "assumed", "timed_out", "orphaned"]
    answer: str
    arbitrated_by: Literal["user", "ceo"] | None = absent(
        "裁决方：user=用户直答；ceo=主管仲裁。旧流缺字段按 user。"
    )
    via_user: bool | None = absent(
        "仅 arbitrated_by=ceo 时有意义：true=主管经 ask_user 转交用户后再 resolve。"
    )


class InteractionOrphanedPayload(WirePayload):
    """热路 pending 交互失效（假卡消灭）。kind ∈ 热路四 kind。"""

    interaction_id: str
    kind: Literal["approval", "delegation_authorization", "escalation", "debate_round"]
