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
    # File the new chat into a folder at creation (a "新建对话 from a folder"), so
    # it is born in that folder's workspace instead of being created-then-moved
    # (which would race the workspace-lock guard once the first turn lands — see
    # 双模式工作区 §九 ⑩). None = ungrouped.
    folder_id: str | None = None


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


class StartDmRequest(BaseModel):
    """Open (or reuse) a 1:1 chat with another user (by their user id)."""

    user_id: str = Field(..., min_length=1, max_length=64)


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
