"""Message, attachment, interaction-resolve, and turn schemas."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from agentcore.api.schemas.usage import UsageBreakdown
from agentcore.runtime.approvals import ApprovalDecision
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.suspension import SuspensionKind


class MessageAttachment(BaseModel):
    """A piece of context the user referenced (@-mention or paperclip).

    Text is extracted/materialized client-side; this MVP carries only
    text-extractable sources (images are out of scope until a vision model).
    ``kind="conversation"`` references another of the user's conversations: its
    recent messages are materialized into ``text`` client-side (same as a file's
    body), and ``conversation_id`` records which one (for the chip + later jump).
    """

    name: str = Field(..., min_length=1, max_length=500)
    path: str = Field(..., max_length=4000)
    # File: extracted text. Directory: a recursive file listing (paths only, no
    # file bodies). Conversation: its recent messages, formatted client-side.
    text: str = Field(..., max_length=300_000)
    truncated: bool = False
    kind: Literal["file", "dir", "conversation"] = "file"
    # Set only for kind="conversation": the referenced conversation's id.
    conversation_id: str | None = None


class StoredAttachment(BaseModel):
    """Persisted attachment display metadata (no extracted text).

    ``workspace_path`` is set when the attachment was written into the durable
    project space (附件驻留): a workspace-relative path under ``attachments/`` that
    the file-download API can serve. ``None`` for directory listings (nothing is
    written to disk) and for legacy rows created before residency.
    """

    name: str
    path: str
    truncated: bool = False
    kind: Literal["file", "dir", "conversation"] = "file"
    workspace_path: str | None = None
    # Set only for kind="conversation": the referenced conversation's id, so the
    # stored chip can label it and (later) jump back to that conversation.
    conversation_id: str | None = None
    # Byte size of the stored file, surfaced for IM file chips (Stage 4 富消息).
    # None for directory listings and legacy rows created before sizing.
    size_bytes: int | None = None
    # Workspace-relative path to a generated WebP thumbnail for an image
    # attachment (Stage 4 富消息); the bubble inlines this instead of the full
    # original. None for non-images / small images / files / legacy rows.
    thumb_path: str | None = None


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)
    attachments: list[MessageAttachment] = Field(default_factory=list, max_length=20)
    # NOTE: a turn no longer carries the local container root — locality is now
    # conversation state (``Conversation.local_container_root_id``, set at creation and
    # read by every promotion path), so a 裸聊 promotes to the same place whether the
    # turn or a panel write lands first (工作区对称化 D1a).


class RegenerateMessageRequest(BaseModel):
    """Re-run a turn from an existing user message.

    The path's ``message_id`` must be a user message. When ``content`` is set the
    user message is edited in place first (edit-and-resend); otherwise the stored
    text is reused as-is (plain regenerate). Either way, every message after that
    user turn is dropped and the assistant reply is produced anew.
    """

    content: str | None = Field(None, min_length=1, max_length=32000)


# --- Interaction resolve (§18.2 unified suspend-resume bridge) ---
# One ``POST /conversations/{id}/interactions/{interaction_id}`` settles any paused
# interaction; the body is discriminated on ``kind`` (approval / ask_user /
# client_tool), each carrying its kind-specific answer. Replaces the three former
# per-kind resolve endpoints + schemas.


class ResolveApprovalInteraction(BaseModel):
    """Settle a paused GRANTABLE tool call (``approval`` interaction).

    ``decision`` is one of ``approve`` (allow this one call), ``approve_always``
    (allow this tool for the rest of the turn), or ``deny`` (refuse).
    """

    kind: Literal["approval"] = "approval"
    decision: ApprovalDecision


class ResolveCheckpointInteraction(BaseModel):
    """Settle a paused checkpoint the CEO raised (``ask_user`` interaction).

    ``decision`` is ``continue`` (proceed with the CEO's direction), ``adjust``
    (steer the CEO with ``note``, then continue), or ``stop`` (end the turn). The
    engine-only ``timeout`` value is never sent by a client. ``note`` carries the
    user's steer for ``adjust`` (and an optional closing remark for ``stop``);
    ``selected`` carries the option(s) the user picked from the CEO's menu — one
    for a single-select ask, several for a ``multiple`` one — and rides ``continue``
    too (the picks are the answer, not just an ``adjust`` steer). The server drops
    any pick that was not in the offered options.
    """

    kind: Literal["ask_user"] = "ask_user"
    decision: CheckpointDecision
    note: str = Field("", max_length=4000)
    selected: list[str] = Field(default_factory=list, max_length=6)


class WorkspaceOpError(BaseModel):
    """A typed failure from a desktop-run local-workspace op (双模式工作区 P2).

    ``kind`` names the ``WorkspaceError`` subclass to re-raise on the server (e.g.
    ``PathNotFound``, ``OutsideWorkspace``) so the file tool maps it to the same
    message as cloud mode; ``count`` carries the match count for ``AmbiguousMatch``
    (str_replace). An unknown ``kind`` degrades to a generic I/O error.
    """

    kind: str = Field(..., max_length=64)
    detail: str = Field("", max_length=2000)
    count: int | None = None


class ResolveClientToolInteraction(BaseModel):
    """Deliver a bound desktop's result for a paused local-workspace op (``client_tool``).

    ``ok`` true → ``value`` is the op's result (op-specific: file text, a directory
    listing, a grep result, …; bytes are base64). ``ok`` false → ``error`` describes
    the typed failure to re-raise. The pending op (awaiting in the live SSE turn)
    resumes with this envelope.
    """

    kind: Literal["client_tool"] = "client_tool"
    ok: bool
    value: Any | None = None
    error: WorkspaceOpError | None = None


class ResolvePlanReviewInteraction(BaseModel):
    """Settle a paused structured DAG checkpoint (``plan_review`` interaction, 结构化挂起 2a).

    Raised when a delegate step marked ``checkpoint_after`` completed and the
    WaveScheduler paused before its dependents. ``decision`` is ``continue`` (run
    the downstream steps as-is), ``adjust`` (inject ``note`` as a steer onto the
    checkpoint's not-yet-run downstream dependents, then proceed), or ``stop`` (end
    the run here). Reuses :class:`CheckpointResponse` (same shape as ask_user) on the
    engine side.
    """

    kind: Literal["plan_review"] = "plan_review"
    decision: CheckpointDecision
    note: str = Field("", max_length=4000)


class ResolveEscalationInteraction(BaseModel):
    """Settle a worker's blocking escalate (``escalation`` interaction, 阻塞式求决策 §4.5).

    Raised when a delegated worker hit a「只有用户能定、且猜错就作废」fork and suspended
    itself to ask the user directly. The user either answers (``answer`` — fed back into the
    worker's loop, overriding its暂定假设) or chooses 按假设继续 (``use_assumption`` true —
    the worker falls back to its stated assumption, the same disposition as a timeout). A
    late resolve (the wait already timed out / was answered) falls through the route as 404,
    so the desktop renders it as「已关闭」rather than an error.
    """

    kind: Literal["escalation"] = "escalation"
    answer: str = Field("", max_length=4000)
    use_assumption: bool = False


# Discriminated union body for the unified resolve endpoint.
ResolveInteractionRequest = (
    ResolveApprovalInteraction
    | ResolveCheckpointInteraction
    | ResolveClientToolInteraction
    | ResolvePlanReviewInteraction
    | ResolveEscalationInteraction
)


def interaction_result_from_body(body: ResolveInteractionRequest) -> Any:
    """Project a resolve-interaction body into the engine-side result its awaiter expects.

    The unified bridge (``runtime/interaction.py``) settles each suspend kind with a
    different typed result, so the wire body is coerced per kind BEFORE it reaches
    ``InteractionRegistry.resolve``:

    - ``approval`` → the bare :class:`~agentcore.runtime.approvals.ApprovalDecision`
      (the gate compares it by identity, so it MUST be the enum member, never a plain
      string — a bare ``"approve_always"`` would silently fail the grant/sweep checks);
    - ``ask_user`` / ``plan_review`` → a
      :class:`~agentcore.runtime.checkpoints.CheckpointResponse` (decision + note, plus
      the user's option picks for ask_user);
    - ``client_tool`` → the desktop op's result envelope dict.

    Shared by the cloud resolve route (``routes/conversations.py``) and the sidecar's
    ``respond`` (``sidecar/server.py``) so both transports settle an interaction
    identically — one construction point, no drift between cloud and local.
    """
    if isinstance(body, ResolveApprovalInteraction):
        return body.decision
    if isinstance(body, ResolveCheckpointInteraction):
        return CheckpointResponse(decision=body.decision, note=body.note, selected=body.selected)
    if isinstance(body, ResolvePlanReviewInteraction):
        return CheckpointResponse(decision=body.decision, note=body.note)
    if isinstance(body, ResolveClientToolInteraction):
        return {
            "ok": body.ok,
            "value": body.value,
            "error": body.error.model_dump() if body.error else None,
        }
    if isinstance(body, ResolveEscalationInteraction):
        # 阻塞式求决策: the escalate channel awaits {answer} | {use_assumption}; 按假设继续
        # is an early timeout (the worker falls back to its assumption).
        return {"answer": body.answer, "use_assumption": body.use_assumption}
    raise ValueError(f"unknown interaction kind: {getattr(body, 'kind', None)!r}")


class ResumeTurnRequest(BaseModel):
    """Body for ``POST .../messages/{message_id}/resume`` (结构化挂起 2b).

    Continues a turn that paused at a plan_review / ask_user checkpoint and was
    DURABLY persisted (so it survived a client disconnect / server restart — the live
    in-process resolve is the corresponding interaction instead). Same decision
    vocabulary as the live resolve: ``continue`` (proceed — run the gated downstream
    for plan_review / accept the CEO direction for ask_user), ``adjust`` (inject
    ``note`` as a steer, then continue), or ``stop`` (end the turn here). ``selected``
    carries the option(s) the user picked from an ask_user menu (ignored for
    plan_review; the server drops any pick not actually offered). The engine-only
    ``timeout`` is never sent by a client.
    """

    decision: CheckpointDecision
    note: str = Field("", max_length=4000)
    selected: list[str] = Field(default_factory=list, max_length=6)


class PausedTurnSummary(BaseModel):
    """A turn awaiting resume after a durable plan_review / ask_user pause (结构化挂起 2b).

    Surfaced on conversation reopen so the client can re-render the right resume card
    by ``kind`` and offer continue / adjust / stop → the resume endpoint.
    ``message_id`` is both the pause key and the id the resumed assistant message will
    reuse, so an optimistic bubble reconciles cleanly.

    plan_review carries ``steps`` (the reviewed checkpoint nodes) + ``pending`` (the
    gated downstream); ask_user carries the unified card payload ``question`` (the
    framing / opening line) + ``context`` + the optional opening content
    ``assumptions`` / ``questions`` / ``style_options`` (empty for a compact mid-task
    fork). The unused set is empty for the other kind.
    """

    message_id: str
    kind: SuspensionKind
    checkpoint_id: str
    user_message: str = ""
    # plan_review
    steps: list[dict[str, Any]] = Field(default_factory=list)
    pending: list[dict[str, Any]] = Field(default_factory=list)
    # ask_user
    question: str = ""
    context: str = ""
    assumptions: list[dict[str, Any]] = Field(default_factory=list)
    questions: list[dict[str, Any]] = Field(default_factory=list)
    style_options: list[dict[str, Any]] = Field(default_factory=list)


class PausedTurnListResponse(BaseModel):
    data: list[PausedTurnSummary] = Field(default_factory=list)
    total: int = 0


class Citation(BaseModel):
    """A web source consulted for an assistant message (source-card data)."""

    url: str
    title: str = ""
    snippet: str = ""
    site: str = ""


class RunError(BaseModel):
    """A turn's terminal error (报错回合), projected from the journal's ``turn_end``
    outcome fact so the inline error card replays on reload (Tier 2 a).

    Live, the error rides a transport-only ``error`` SSE event (never journaled), so
    persisting ``code`` + ``message`` on the outcome fact is its only durable home.
    ``code`` drives the bubble's retry affordance; ``message`` is the user-facing text
    the card shows — the same pair the live ``error`` event carried.
    """

    code: str
    message: str


class RunsPayload(BaseModel):
    """Persisted turn replay payload for an assistant message.

    ``events`` is a multi-agent turn's ordered run/tool SSE events; the client
    replays them through the same fold as the live stream to reproduce the team
    graph exactly on reload (empty ``[]`` for a single-agent turn). ``process`` is
    a single-agent turn's 思考+工具 timeline (ordered reasoning/tool steps) the
    client replays into the inline process panel; ``null`` unless the turn used a
    tool. ``captain_context`` is the CEO captain's received context (上下文传递可视化
    通道①: ``system`` / ``history`` / ``request``), turn-level so it replays on the
    CEO bubble even for a pure-chat turn (where ``events`` is empty); ``null`` unless
    the captain shipped context. ``error`` is a 报错回合's terminal error, replaying the
    inline error card on reload (``null`` for a clean turn). ``null`` whole payload on
    messages with none of these.
    """

    events: list[dict[str, Any]] = Field(default_factory=list)
    finish_reason: str | None = None
    process: list[dict[str, Any]] | None = None
    captain_context: list[dict[str, Any]] | None = None
    error: RunError | None = None


class MessageDetail(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str | None
    reasoning_content: str | None = None
    # trace_id 关联气泡↔日志: the turn's log correlation id (messages.trace_id column),
    # surfaced so a reloaded bubble can copy it for one-step log lookup — live it rides
    # the message_start event. NULL for user / untraced (handoff) rows. Auto-populated
    # from the ORM attribute via from_attributes.
    trace_id: str | None = None
    attachments: list[StoredAttachment] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    runs: RunsPayload | None = None
    # 回合 token 用量 + 轮次 (Tier 2 重载持久化): the assistant row's ``usage`` column carries
    # the turn's token snapshot + rounds; surfaced so the bubble's meta row (用量 + 轮次)
    # replays on reload — live, they ride ``message_end``. ``usage`` is projected from the
    # column's long-key snapshot to the ledger short-key {@link UsageBreakdown} via the
    # validator below; ``rounds`` shares the column but has no own attribute, so the read
    # route sets it. Both ``null`` for user / pre-feature rows (and ``usage`` for an
    # errored / empty turn that spent no tokens — parity with the live bubble's omission).
    usage: UsageBreakdown | None = None
    rounds: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}

    @field_validator("usage", mode="before")
    @classmethod
    def _usage_from_row(cls, v: object) -> object:
        # The ORM ``usage`` column is a long-key snapshot ({input_tokens, …, rounds}).
        # Project it to the short-key UsageBreakdown the client reads; show tokens only
        # when the turn reported real spend (an errored / empty turn stored zeros, which
        # the live bubble also omits). A value already in UsageBreakdown shape passes
        # through unchanged (so model construction outside from_attributes still works).
        if isinstance(v, dict):
            if not (v.get("input_tokens") or v.get("output_tokens")):
                return None
            return {
                "input": v.get("input_tokens", 0),
                "output": v.get("output_tokens", 0),
                "reasoning": v.get("reasoning_tokens", 0),
                "cache_hit": v.get("cache_hit_tokens", 0),
                "cache_miss": v.get("cache_miss_tokens", 0),
            }
        return v


class MessageListResponse(BaseModel):
    """A window of a conversation's messages (chronological, oldest-first).

    Cursor-windowed rather than page-numbered: the client loads the latest window
    on open, then scrolls up (``before``) / down (``after``), or jumps to a window
    centered on a message (``around``) for a search hit. ``has_more_before`` /
    ``has_more_after`` tell the client whether to keep fetching in that direction.
    Only the direction-relevant flag is computed for a one-sided query (a
    ``before`` page sets ``has_more_after=False``; the client already holds the
    newer side); an ``around`` window computes both.
    """

    data: list[MessageDetail]
    total: int
    has_more_before: bool = False
    has_more_after: bool = False


# --- Local turn recording (双模式工作区 §一.1: sidecar 本地引擎回合回传落库) ---
# A turn run by the local sidecar engine produced its reply on the user's machine —
# no server pipeline ran — so the desktop reports the finished turn here to land it
# in durable history (入库 / 跨设备) AND in the cost ledger (计费回写). Workspace
# snapshots stay out of scope (local files live on the user's disk; the local→云
# handoff is the separate explicit bridge).


class RecordTurnRequest(BaseModel):
    """A finished local (sidecar) turn to persist: the user message + assistant reply.

    Carries the assistant outcome the local pipeline returned (content / reasoning /
    citations / replay ``runs`` / the pipeline ``message_id`` so streamed and stored
    ids agree). The display token totals ride on ``Message.usage``. Spend is NOT sent:
    a sidecar turn's LLM calls are metered authoritatively at the cloud inference proxy
    (``/v1/inference``, Slice 4a), so this write-back persists content only.
    """

    user_message: str = Field(..., min_length=1, max_length=32000)
    content: str = Field("", max_length=500_000)
    reasoning_content: str | None = Field(None, max_length=500_000)
    citations: list[Citation] = Field(default_factory=list, max_length=50)
    runs: RunsPayload | None = None
    # The client-minted id of the user bubble (a clean UUID). Pinning the persisted
    # user row to it makes the whole write-back idempotent: the desktop retries this
    # POST on a flaky response, and a retry after a write we DID commit must not
    # duplicate the user/assistant rows (双模式工作区 §一.1 回写可靠性).
    user_message_id: str = Field(..., min_length=1, max_length=64)
    message_id: str | None = Field(None, max_length=64)
    input_tokens: int = Field(0, ge=0)
    output_tokens: int = Field(0, ge=0)
    rounds: int = Field(0, ge=0)
    # The local turn's trace_id (32-hex), stamped by the desktop on every cloud
    # inference-proxy LLM call this turn made. Reusing it for the persisted reply joins
    # the reasoning logs + the bubble under ONE trace (打通气泡↔日志).
    trace_id: str = Field(..., min_length=32, max_length=32)


class RecordTurnResponse(BaseModel):
    """The persisted ids for a recorded local turn (the desktop reconciles its
    optimistic user/assistant bubbles against these; ``title`` is set only when this
    turn minted the conversation's first title)."""

    user_message_id: str
    assistant_message_id: str | None = None
    title: str | None = None


class StopTurnResponse(BaseModel):
    """Outcome of an explicit 停止 (执行与请求解耦 C1 · slice 1a).

    ``stopped`` is True when a live detached run was found for the conversation and
    signalled to cancel; False when nothing was running (already finished / never
    started), so the call is idempotent and the client can settle the bubble either
    way."""

    stopped: bool
