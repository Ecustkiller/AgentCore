"""Pydantic request/response schemas for API layer."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.approvals import ApprovalDecision

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


class ConversationSummary(BaseModel):
    id: str
    title: str | None
    updated_at: datetime
    created_at: datetime
    # Folder membership; None = ungrouped (see 前端UX目标态 §七).
    folder_id: str | None = None
    # Local-mode binding for an *ungrouped* conversation; None = cloud. A foldered
    # conversation derives its mode from the folder's binding instead (§七).
    local_root_id: str | None = None

    model_config = {"from_attributes": True}


class ConversationListResponse(BaseModel):
    data: list[ConversationSummary]
    total: int
    page: int
    page_size: int


class UpdateConversationRequest(BaseModel):
    title: str | None = None


class MoveConversationRequest(BaseModel):
    """Move a conversation into a folder, or out of one with ``folder_id=null``."""

    folder_id: str | None = None


# --- Folders (sidebar grouping) ---


class CreateFolderRequest(BaseModel):
    name: str
    local_dir: str | None = None


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


class ResolveApprovalRequest(BaseModel):
    """Settle a paused GRANTABLE tool call (tool approval gate).

    ``decision`` is one of ``approve`` (allow this one call), ``approve_always``
    (allow this tool for the rest of the turn), or ``deny`` (refuse).
    """

    decision: ApprovalDecision


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


class ResolveWorkspaceOpRequest(BaseModel):
    """Deliver a desktop's result for a paused local-workspace op.

    ``ok`` true → ``value`` is the op's result (op-specific: file text, a
    directory listing, a grep result, …; bytes are base64). ``ok`` false →
    ``error`` describes the typed failure to re-raise. The pending op (awaiting in
    the live SSE turn) resumes with this envelope.
    """

    ok: bool
    value: Any | None = None
    error: WorkspaceOpError | None = None


class Citation(BaseModel):
    """A web source consulted for an assistant message (source-card data)."""

    url: str
    title: str = ""
    snippet: str = ""
    site: str = ""


class RunsPayload(BaseModel):
    """Persisted multi-agent execution journal for an assistant message.

    ``events`` is the turn's ordered run/tool SSE events; the client replays them
    through the same fold as the live stream to reproduce the team graph exactly
    on reload. ``null`` on messages with no delegation (user / single-agent).
    """

    events: list[dict[str, Any]] = Field(default_factory=list)
    finish_reason: str | None = None


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
    data: list[MessageDetail]
    total: int
    page: int
    page_size: int


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


# --- Workspace files (bring files in / take results out) ---


class WorkspaceFileEntry(BaseModel):
    """One entry in a workspace listing — relative POSIX path + kind."""

    path: str
    is_dir: bool

    model_config = {"from_attributes": True}


class WorkspaceFileListResponse(BaseModel):
    data: list[WorkspaceFileEntry]
    total: int


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


class UsageSummary(BaseModel):
    """Account dashboard payload (``GET /usage/summary``).

    Also carries ``cny_per_usd`` so the client formats money from a single
    server-owned rate (it never hard-codes the FX rate).
    """

    today: UsageWindow
    month: UsageWindow
    quota: QuotaStatus
    cny_per_usd: float


# --- Generic ---


class StatusResponse(BaseModel):
    status: str = "ok"
