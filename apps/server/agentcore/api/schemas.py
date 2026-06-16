"""Pydantic request/response schemas for API layer."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.approvals import ApprovalDecision
from agentcore.runtime.checkpoints import CheckpointDecision
from agentcore.runtime.suspension import SuspensionKind

# --- Auth ---


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=8, max_length=256)
    invite_code: str = Field(..., min_length=1, max_length=64)
    display_name: str | None = Field(None, max_length=200)
    # Plain string for now (email is a reserved/optional profile field); upgrade
    # to validated EmailStr if/when email-validator is added as a dependency.
    email: str | None = Field(None, max_length=255)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=256)


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None
    role: str
    created_at: datetime
    # The user's default 质量档 (llm/modes.py): a preset name or custom mode id;
    # None = inherit the operator default. Surfaced so the client knows the default
    # at login without a second call.
    default_model_mode: str | None = None


class CreateInviteRequest(BaseModel):
    # None = never expires; otherwise the code is valid for this many days.
    expires_in_days: int | None = Field(None, ge=1, le=365)


class InviteResponse(BaseModel):
    id: str
    code: str
    status: Literal["active", "used", "expired"]
    created_by: str | None
    used_by: str | None
    created_at: datetime
    expires_at: datetime | None
    used_at: datetime | None


class InviteListResponse(BaseModel):
    data: list[InviteResponse]
    total: int


# --- Conversations ---


class CreateConversationRequest(BaseModel):
    title: str | None = None
    # File the new chat into a folder at creation (a "新建对话 from a folder"), so
    # it is born in that folder's workspace instead of being created-then-moved
    # (which would race the workspace-lock guard once the first turn lands — see
    # 双模式工作区 §九 ⑩). None = ungrouped.
    folder_id: str | None = None
    # Initial 质量档 (llm/modes.py): a preset name or custom mode id; None = inherit
    # the user's default → operator default.
    model_mode: str | None = None


class ConversationSummary(BaseModel):
    id: str
    title: str | None
    updated_at: datetime
    created_at: datetime
    # Number of messages; 0 for a brand-new, unsent chat. The sidebar uses this to
    # lock workspace-changing folder moves once a conversation has started (双模式
    # 工作区 §九 ⑩). Populated by the list/grouped endpoints; defaults to 0 on the
    # single-conversation responses where the count isn't needed.
    message_count: int = 0
    # Folder membership; None = 裸聊 (ungrouped, no workspace yet). A conversation's
    # workspace/mode is derived from its folder (文件夹即工作区); see 会话列表设计.
    folder_id: str | None = None
    # Selected 质量档 (llm/modes.py); None = inherit user default → operator default.
    model_mode: str | None = None
    # Sidebar housekeeping (对话基础功能补齐). ``pinned`` floats the row to the top
    # (置顶对话); ``archived`` marks it as hidden from the live list (归档对话) — the
    # grouped/live endpoints already exclude archived rows, so this is True only on
    # the「已归档」view's payloads.
    pinned: bool = False
    archived: bool = False

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    data: list[ConversationSummary]
    total: int
    page: int
    page_size: int


class UpdateConversationRequest(BaseModel):
    title: str | None = None
    # Selected 质量档 (llm/modes.py); explicit null clears back to「inherit default」.
    # Optional: omit to leave unchanged (the route reads ``model_fields_set``).
    model_mode: str | None = None
    # Sidebar housekeeping toggles (对话基础功能补齐). Optional — omit to leave
    # unchanged (the route reads ``model_fields_set``); never null (no tri-state).
    pinned: bool | None = None
    archived: bool | None = None


class MoveConversationRequest(BaseModel):
    """Move a conversation into a folder, or out of one with ``folder_id=null``."""

    folder_id: str | None = None


# --- Model quality modes (质量档, llm/modes.py D2) ---


class ModelModeSummary(BaseModel):
    """A user-defined custom 质量档."""

    id: str
    name: str
    # Team-role → model id (e.g. {"ceo": "deepseek-v4-pro"}). Roles absent inherit
    # the base profile's model.
    assignments: dict[str, str]

    model_config = {"from_attributes": True}


class CreateModelModeRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    assignments: dict[str, str] = Field(default_factory=dict)


class UpdateModelModeRequest(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100)
    assignments: dict[str, str] | None = None


class ModelModePreset(BaseModel):
    """A built-in, read-only 质量档 (economy / quality)."""

    key: str
    assignments: dict[str, str]


class ModelModesResponse(BaseModel):
    """Everything the picker needs: built-in presets + the user's custom modes + the
    user's resolved default ref."""

    presets: list[ModelModePreset]
    custom: list[ModelModeSummary]
    default_mode: str


class ModelRoleOption(BaseModel):
    """A team role the user may configure in a custom mode (catalog)."""

    role: str
    configurable: bool
    # When not configurable (经济worker), the model it is locked to (display only).
    locked_model: str | None = None


class ModelModeCatalog(BaseModel):
    """The operator-bounded option space for building a custom mode: which team roles
    exist (and whether each is user-configurable) and which models may be picked."""

    roles: list[ModelRoleOption]
    models: list[str]


class SetDefaultModeRequest(BaseModel):
    """Set (or clear with null) the user's default 质量档."""

    mode: str | None = None


# --- BYOK LLM key (用户自带 DeepSeek key, llm/key_service.py) ---


class SetLlmKeyRequest(BaseModel):
    """Store the user's own DeepSeek API key (BYOK)."""

    api_key: str = Field(..., min_length=1, max_length=400)


class LlmKeyStatusResponse(BaseModel):
    """Settings view of a user's BYOK key — never the plaintext key."""

    configured: bool
    # unconfigured | unchecked | active | error
    status: str
    # Last 4 chars only (e.g. "••••cdef"), for recognition.
    masked_key: str | None = None
    # Connectivity-test failure reason (POST .../test), surfaced when status="error".
    message: str | None = None


# --- Folders (sidebar grouping) ---


class CreateFolderRequest(BaseModel):
    name: str
    local_dir: str | None = None
    # Bind the new folder to a desktop FS root at creation (文件中枢统一 F2:
    # "添加文件夹 = 建本地绑定项目"). The hub turns a picked local directory into a
    # local project in one step; present ⇒ the folder (and its conversations) run
    # in local mode against this root (§七).
    local_root_id: str | None = None


class UpdateFolderRequest(BaseModel):
    name: str | None = None
    local_dir: str | None = None


class FolderSummary(BaseModel):
    id: str
    name: str
    local_dir: str | None
    # Local-mode binding (desktop FS root id); None = cloud. Drives the mode badge
    # for the folder and all its conversations (§七).
    local_root_id: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class FolderGroup(BaseModel):
    """A folder plus the conversations it holds (grouped sidebar payload)."""

    id: str
    name: str
    local_dir: str | None
    local_root_id: str | None = None
    conversations: list[ConversationSummary]


class GroupedConversationsResponse(BaseModel):
    folders: list[FolderGroup]
    ungrouped: list[ConversationSummary]


# --- Workspace local-mode binding (双模式工作区 §七) ---


class BindLocalWorkspaceRequest(BaseModel):
    """Bind a conversation's workspace to a desktop FS root (switch to local mode).

    ``root_id`` is the desktop-minted handle for an authorized local directory
    (from the desktop ``addRoot`` flow). Binding writes at the governing scope: the
    folder for a foldered conversation (shared by its siblings), the conversation
    itself when ungrouped.
    """

    root_id: str = Field(..., min_length=1, max_length=200)


class WorkspaceBindingResponse(BaseModel):
    """A conversation's resolved workspace mode + where its binding lives."""

    mode: Literal["local", "cloud"]
    # Which record carries the binding: the shared folder, or the conversation.
    scope: Literal["folder", "conversation"]
    # The bound desktop root id when local; None when cloud.
    root_id: str | None = None


class WorkspaceSummary(BaseModel):
    """One addressable workspace in the file hub (文件中枢统一 Step 1).

    A folder project (``folder:<id>``) or an ungrouped conversation space
    (``conv:<id>``). ``location`` tells the hub how to reach its files: a cloud
    workspace via the ``/v1/workspaces/{ws_id}/files`` REST family; a local one
    over desktop IPC against ``root_id`` (its server-side dir is not the truth).
    """

    ws_id: str
    name: str
    location: Literal["cloud", "local"]
    # The bound desktop root id when local; None when cloud.
    root_id: str | None = None
    # Whether the space holds files. Folders always list (a project is a project);
    # ungrouped spaces list only when non-empty (F1) — so this is the filter that
    # let them in. Always True for local (the server can't see local files).
    has_files: bool


class WorkspaceListResponse(BaseModel):
    data: list[WorkspaceSummary]
    total: int


# --- Messages ---


class MessageAttachment(BaseModel):
    """A file the user referenced (@-mention or paperclip) as message context.

    Text is extracted client-side from an authorized local root; this MVP carries
    only text-extractable files (images are out of scope until a vision model).
    """

    name: str = Field(..., min_length=1, max_length=500)
    path: str = Field(..., max_length=4000)
    # File: extracted text. Directory: a recursive file listing (paths only, no
    # file bodies) built client-side.
    text: str = Field(..., max_length=300_000)
    truncated: bool = False
    kind: Literal["file", "dir"] = "file"


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
    kind: Literal["file", "dir"] = "file"
    workspace_path: str | None = None


class SendMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)
    attachments: list[MessageAttachment] = Field(default_factory=list, max_length=20)


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


# Discriminated union body for the unified resolve endpoint.
ResolveInteractionRequest = (
    ResolveApprovalInteraction
    | ResolveCheckpointInteraction
    | ResolveClientToolInteraction
    | ResolvePlanReviewInteraction
)


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
    gated downstream); ask_user carries ``question`` / ``options`` / ``context`` /
    ``multiple`` (the CEO's decision prompt). The unused set is empty for the other
    kind.
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
    options: list[str] = Field(default_factory=list)
    context: str = ""
    multiple: bool = False


class PausedTurnListResponse(BaseModel):
    data: list[PausedTurnSummary] = Field(default_factory=list)
    total: int = 0


class Citation(BaseModel):
    """A web source consulted for an assistant message (source-card data)."""

    url: str
    title: str = ""
    snippet: str = ""
    site: str = ""


class RunsPayload(BaseModel):
    """Persisted turn replay payload for an assistant message.

    ``events`` is a multi-agent turn's ordered run/tool SSE events; the client
    replays them through the same fold as the live stream to reproduce the team
    graph exactly on reload (empty ``[]`` for a single-agent turn). ``process`` is
    a single-agent turn's 思考+工具 timeline (ordered reasoning/tool steps) the
    client replays into the inline process panel; ``null`` unless the turn used a
    tool. ``null`` whole payload on messages with neither (plain chat / user).
    """

    events: list[dict[str, Any]] = Field(default_factory=list)
    finish_reason: str | None = None
    process: list[dict[str, Any]] | None = None


class MessageDetail(BaseModel):
    id: str
    conversation_id: str
    role: str
    content: str | None
    reasoning_content: str | None = None
    attachments: list[StoredAttachment] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    runs: RunsPayload | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


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


# --- Global search (全局搜索 Tier 1: 跨对话/消息/文件夹关键词检索) ---
# One keyword query fans out over the user's own conversations (title), messages
# (content) and folders (name) — see 前端技术与架构.md §9.8. Backed by ILIKE
# (no tsvector — stock PG doesn't segment Chinese); results are owner-scoped.


class SearchItem(BaseModel):
    """One hit in a section. Field meaning depends on the section ``type``:

    - conversation: ``id`` = conversation id, ``title`` = its title.
    - message: ``id`` = message id, ``conversation_id`` = where to jump,
      ``title`` = the owning conversation's title (list-row context), ``role`` =
      user/assistant, ``snippet`` = match window with ``match_start``/``match_end``
      offsets into the snippet for client-side highlighting.
    - folder: ``id`` = folder id, ``title`` = its name.
    """

    id: str
    title: str | None = None
    conversation_id: str | None = None
    role: str | None = None
    snippet: str | None = None
    match_start: int | None = None
    match_end: int | None = None
    updated_at: datetime | None = None


class SearchSection(BaseModel):
    """Hits of one entity type, recency-ordered (newest first)."""

    type: Literal["conversation", "message", "folder"]
    items: list[SearchItem]


class SearchResponse(BaseModel):
    query: str
    sections: list[SearchSection]


# --- Workspace snapshots ---


class CreateSnapshotRequest(BaseModel):
    """Take a manual snapshot of a conversation's workspace.

    A non-empty ``label`` marks a kept version (手动留版本) — a name the user
    pins — vs. the automatic post-turn backups.
    """

    label: str | None = Field(None, max_length=200)


class SnapshotSummary(BaseModel):
    """One persisted workspace snapshot (kept version or automatic backup)."""

    snapshot_id: str
    label: str | None
    created_at: datetime
    size_bytes: int

    model_config = {"from_attributes": True}


class SnapshotListResponse(BaseModel):
    data: list[SnapshotSummary]
    total: int


# --- Handoff jobs (本地→云交接: 云端在快照上跑团队, 双模式工作区 P2e / e2) ---


class DispatchHandoffRequest(BaseModel):
    """Hand a task off to a cloud team seeded from the local workspace snapshot."""

    task: str


class HandoffJobSummary(BaseModel):
    """One local→云 handoff job: its lifecycle + the snapshots bracketing it.

    ``base_snapshot_id`` is the user's local files the cloud team ran on (the e3
    diff base, under the source conversation's storage key); ``result_snapshot_id``
    is the team's output (under the hidden job conversation's key), NULL until the
    run succeeds. ``job_conversation_id`` hosts the team's replayable graph.
    """

    id: str
    source_conversation_id: str
    job_conversation_id: str
    base_snapshot_id: str
    result_snapshot_id: str | None
    task: str
    status: Literal["pending", "running", "succeeded", "failed"]
    error: str | None
    created_at: datetime
    updated_at: datetime
    finished_at: datetime | None

    model_config = {"from_attributes": True}


class HandoffJobListResponse(BaseModel):
    data: list[HandoffJobSummary]
    total: int


class HandoffFileChange(BaseModel):
    """One file's base→result delta in a finished handoff (双模式工作区 P2e / e3).

    ``base_sha`` / ``result_sha`` are sha256 hex on each side (null when absent:
    base for an add, result for a delete). ``content`` is the result's UTF-8 text
    for an add/modify (null for a delete, or for a binary result — ``is_binary``
    flags the latter, fetched via snapshot download). The desktop hashes its current
    local copy and three-way-classifies each entry against ``base_sha`` before
    applying (clean / already-applied / conflict).
    """

    path: str
    change_type: Literal["added", "modified", "deleted"]
    base_sha: str | None
    result_sha: str | None
    is_binary: bool
    content: str | None
    size_bytes: int

    model_config = {"from_attributes": True}


class HandoffDiffResponse(BaseModel):
    """A finished handoff's result diff: the change set to apply back to local files.

    ``data`` is the per-file change set (sorted by path); ``added`` / ``modified`` /
    ``deleted`` are counts for the PR-card header.
    """

    job_id: str
    data: list[HandoffFileChange]
    total: int
    added: int
    modified: int
    deleted: int


class HandoffApplySelection(BaseModel):
    """One file's apply decision in a handoff PR review (双模式工作区 P2e / e3).

    ``decision`` is ``cloud`` (take the team's version) or ``local`` (keep the
    user's). ``local_sha`` is the hash the desktop currently sees for the file — the
    third input to the server's authoritative three-way conflict check (null when
    the file is absent locally). ``force`` applies the cloud version even when the
    server judges a conflict (the user's explicit override after seeing it flagged).
    """

    path: str
    decision: Literal["cloud", "local"] = "cloud"
    local_sha: str | None = None
    force: bool = False


class ApplyHandoffRequest(BaseModel):
    """Apply selected result changes from a finished handoff back to local files.

    ``selections`` carries one entry per file the user decided on; files not listed
    are left untouched locally. The apply streams SSE (it drives WRITE_BYTES / DELETE
    ops the bound desktop fulfils) and ends with a ``handoff_apply_done`` event.
    """

    selections: list[HandoffApplySelection]


# --- Workspace files (bring files in / take results out) ---


class WorkspaceFileEntry(BaseModel):
    """One entry in a workspace listing — relative POSIX path + kind."""

    path: str
    is_dir: bool

    model_config = {"from_attributes": True}


class WorkspaceFileListResponse(BaseModel):
    data: list[WorkspaceFileEntry]
    total: int


class WorkspaceFileIndexResponse(BaseModel):
    """Flat file-path list for @ mentions (文件中枢统一 F4).

    Files only (no dirs), ignore-pruned, capped — ``truncated`` is True when the
    cap was hit. Mirrors the desktop ``fsApi.listFiles`` so cloud workspace files
    can feed the same @ index local roots already do.
    """

    data: list[str]
    total: int
    truncated: bool


class UploadFileResponse(BaseModel):
    """Result of a workspace file upload."""

    path: str
    size_bytes: int


class MoveFileRequest(BaseModel):
    """Move/rename a workspace file or directory (both workspace-relative)."""

    src: str = Field(..., min_length=1, max_length=1000)
    dst: str = Field(..., min_length=1, max_length=1000)


class CreateDirRequest(BaseModel):
    """Create a workspace directory (workspace-relative, parents created)."""

    path: str = Field(..., min_length=1, max_length=1000)


class CloneRepoRequest(BaseModel):
    """Clone a public git repository into the conversation's workspace."""

    repo_url: str = Field(..., min_length=1, max_length=2000)
    # Optional workspace-relative target dir; defaults to the repo name.
    dest: str | None = Field(None, max_length=500)


class CloneRepoResponse(BaseModel):
    """Result of a workspace clone — the relative dir the repo landed in."""

    path: str


# --- Tools ---


class ToolInfo(BaseModel):
    """A built-in tool's public catalog entry (read-only).

    ``approval`` is the tool's governance level (``never`` / ``grantable`` /
    ``always``); ``parameters`` is the JSON Schema the model fills to call it.
    """

    name: str
    description: str
    category: ToolCategory
    approval: ToolApproval
    parameters: dict[str, Any]


class ToolListResponse(BaseModel):
    data: list[ToolInfo]
    total: int


# --- Cost & usage (团队工资单 + 账户仪表盘) ---
# Money is integer nano-USD (1 USD = 1e9) everywhere — never a float. The single
# display-only CNY conversion rides on `cny_total` (server-side via CNY_PER_USD),
# so the client never re-derives money. Token fields use the ledger short keys
# (matching cost_events.tokens / RunState.usage), distinct from message_end's
# legacy `*_tokens` SSE shape.


class CostBreakdown(BaseModel):
    """A run's / turn's / window's cost in integer nano-USD (canonical)."""

    input: int
    cached: int
    output: int
    total: int
    currency: str = "USD"
    # Display-only CNY value (元), converted server-side via the single
    # CNY_PER_USD rate so the client shows money without re-pricing.
    cny_total: float


class UsageBreakdown(BaseModel):
    """Token counts (cache_hit + cache_miss == input; reasoning ⊆ output)."""

    input: int
    output: int
    reasoning: int
    cache_hit: int
    cache_miss: int


class AgentCostLine(BaseModel):
    """One participant's row in the team payroll (one Run = one Agent)."""

    run_id: str
    agent_id: str | None
    role: str
    model: str
    usage: UsageBreakdown
    cost: CostBreakdown
    duration_ms: int


class TurnCost(BaseModel):
    """A turn's cost + per-Agent payroll (``GET /messages/{id}/cost``).

    Rebuilt from the ``cost_events`` ledger by message_id, so it replays a past
    turn's payroll on reload. ``agents`` is empty when the turn has no ledger
    rows (e.g. unknown / non-owned message — never leaks existence).
    """

    message_id: str
    usage: UsageBreakdown
    cost: CostBreakdown
    rounds: int
    agents: list[AgentCostLine]


class ConversationCost(BaseModel):
    """A conversation's cumulative spend (``GET /conversations/{id}/cost``)."""

    conversation_id: str
    usage: UsageBreakdown
    cost: CostBreakdown
    turns: int


class UsageWindow(BaseModel):
    """Aggregated usage over a time window (today / month)."""

    usage: UsageBreakdown
    cost: CostBreakdown
    # Distinct assistant turns in the window (the quota's「请求」proxy).
    requests: int


class QuotaStatus(BaseModel):
    """Free-tier limits (决策④); 0 = unlimited. Money is USD nano internally."""

    daily_tokens: int
    monthly_cost_nano: int
    daily_requests: int


class RoleCostLine(BaseModel):
    """One role's spend over a window — the team payroll grouped by role.

    The account dashboard's product differentiator (§7.3D): multi-agent spend
    splits by the ledger ``role`` (CEO / 队员 / 汇总 / …), which a single-agent
    competitor can't show. Money is integer nano-USD; the client formats ¥ from
    the summary's single ``cny_per_usd`` (no per-row re-pricing here).
    """

    role: str
    cost_total: int
    # Distinct assistant turns this role took part in over the window.
    turns: int


class DailyCost(BaseModel):
    """One UTC day's total spend — a point in the dashboard 7-day trend (§7.3D)."""

    # ISO date (YYYY-MM-DD) of the UTC calendar day.
    date: str
    cost_total: int


class UsageSummary(BaseModel):
    """Account dashboard payload (``GET /usage/summary``).

    Also carries ``cny_per_usd`` so the client formats money from a single
    server-owned rate (it never hard-codes the FX rate).
    """

    today: UsageWindow
    month: UsageWindow
    # This month's spend split by role (团队工资单 by role), spend-desc, >0 only.
    month_by_role: list[RoleCostLine]
    # Last 7 UTC days incl today, oldest-first, zero-filled — the trend sparkline.
    recent_daily_cost: list[DailyCost]
    quota: QuotaStatus
    cny_per_usd: float
    # Billing mode (config.billing_mode). In "byok" the platform quota is dormant
    # (the turn runs on the user's own key), so the client reframes the quota meters
    # as「自带 Key 不限额」and presents cost as the user's own DeepSeek spend.
    billing_mode: str


# --- Messaging (消息页 = 找人 IM; 消息IM.md) ---
# A separate surface from the AI 对话 page: human↔human chat + an official account.
# Shares the frontend chat core, not the AI conversation/messages schemas.


class UserSearchResult(BaseModel):
    """A discoverable user surfaced by people-search (任意搜人, exact match)."""

    id: str
    username: str
    display_name: str

    model_config = {"from_attributes": True}


class UserSearchResponse(BaseModel):
    data: list[UserSearchResult]
    total: int


class ChatParticipant(BaseModel):
    """A human shown on a chat (the peer of a dm; members of a group)."""

    id: str
    username: str
    display_name: str
    # Platform admin (创始团队 = the 内测群's moderators); lets the roster badge
    # official accounts and hide kick/mute on them. False for the dm peer.
    is_admin: bool = False
    # Admin-imposed 禁言 (Stage 3): this group member can read but not send.
    muted_by_admin: bool = False

    model_config = {"from_attributes": True}


class ChatSummary(BaseModel):
    """One row in the IM chat list (消息页左栏), plus this user's per-chat state."""

    id: str
    type: Literal["dm", "group", "official"]
    title: str | None = None
    avatar_url: str | None = None
    # The other human in a dm (None for group/official); drives the list-row name.
    peer: ChatParticipant | None = None
    last_message_at: datetime | None = None
    last_message_preview: str | None = None
    unread: int = 0
    pinned: bool = False
    muted: bool = False
    # 'pending' = a stranger message request awaiting this user's accept (消息请求).
    state: Literal["accepted", "pending"] = "accepted"


class ChatListResponse(BaseModel):
    data: list[ChatSummary]
    total: int


class ChatMembersResponse(BaseModel):
    """A chat's members (group roster: resolves sender names + the member panel)."""

    data: list[ChatParticipant]
    total: int


class StartDmRequest(BaseModel):
    """Open (or reuse) a 1:1 chat with another user (by their user id)."""

    user_id: str = Field(..., min_length=1, max_length=64)


class UpdateMembershipRequest(BaseModel):
    """Patch this user's per-chat flags (mute / pin); omitted fields unchanged."""

    muted: bool | None = None
    pinned: bool | None = None


class AdminMuteRequest(BaseModel):
    """Admin 禁言 toggle for a group member (muted = can read, can't send)."""

    muted: bool


class AnnounceRequest(BaseModel):
    """Post an admin announcement into a chat as a centered system_card (官方公告)."""

    content: str = Field(..., min_length=1, max_length=2000)


class ChatMessageDetail(BaseModel):
    id: str
    chat_id: str
    # NULL sender = the official/system account.
    sender_user_id: str | None
    sender_type: Literal["user", "official", "agent"]
    content: str | None
    content_type: Literal["text", "image", "file", "system_card"]
    attachments: list[StoredAttachment] = Field(default_factory=list)
    # system_card deep-link payload (e.g. {kind, conversation_id}); None otherwise.
    payload: dict[str, Any] | None = None
    reply_to_message_id: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class ChatMessageListResponse(BaseModel):
    data: list[ChatMessageDetail]
    total: int
    page: int
    page_size: int


class SendChatMessageRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=32000)
    # Client-minted id for retry-safe idempotent send (dedup at the unique index).
    client_msg_id: str | None = Field(None, max_length=100)
    reply_to_message_id: str | None = Field(None, max_length=64)


class MarkReadRequest(BaseModel):
    """Advance this user's read cursor (drives unread counts + read receipts)."""

    last_read_message_id: str = Field(..., min_length=1, max_length=64)


class DirectorySettings(BaseModel):
    """A user's discoverability + who-can-DM privacy (任意搜人 护栏)."""

    discoverable: bool = True
    who_can_dm: Literal["anyone", "contacts"] = "anyone"

    model_config = {"from_attributes": True}


class UpdateDirectorySettingsRequest(BaseModel):
    discoverable: bool | None = None
    who_can_dm: Literal["anyone", "contacts"] | None = None


class BlockUserRequest(BaseModel):
    user_id: str = Field(..., min_length=1, max_length=64)


class BlockedUser(BaseModel):
    id: str
    username: str
    display_name: str

    model_config = {"from_attributes": True}


class BlockListResponse(BaseModel):
    data: list[BlockedUser]
    total: int


# --- Generic ---


class StatusResponse(BaseModel):
    status: str = "ok"
