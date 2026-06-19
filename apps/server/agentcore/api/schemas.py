"""Pydantic request/response schemas for API layer."""

from datetime import datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field, model_validator

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.approvals import ApprovalDecision
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.suspension import SuspensionKind

if TYPE_CHECKING:
    from agentcore.db.models import User


def _avatar_url(user_id: str, avatar_key: str | None) -> str | None:
    """Derive the served avatar URL from the stored object key (or None).

    ``avatars/<id>/<hash>.webp`` → ``/v1/users/<id>/avatar?v=<hash>``: a relative
    path (client prefixes its API base) with the content hash as a cache-buster, so
    the served <img> changes exactly when the picture does. → api/routes/users.py.
    """
    if not avatar_key:
        return None
    version = PurePosixPath(avatar_key).stem
    return f"/v1/users/{user_id}/avatar?v={version}"

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


class ChangePasswordRequest(BaseModel):
    """Self-service password change (修改密码): the current password proves intent,
    the new one is validated server-side (same ≥8 policy as registration)."""

    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=8, max_length=256)


class UpdateProfileRequest(BaseModel):
    """Patch the signed-in user's profile (个人资料编辑). Both fields optional — only
    those present are changed; an explicit ``null`` email clears it. ``display_name``
    must be non-empty when present (enforced in the service)."""

    display_name: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=255)


class DeleteAccountRequest(BaseModel):
    """Self-service account deletion (注销账户): the password re-confirms a
    destructive, irreversible action before the account is soft-deleted + anonymized."""

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
    # Served avatar URL (头像) derived from the stored object key, e.g.
    # ``/v1/users/<id>/avatar?v=<hash>``; None = no avatar. A relative path on
    # purpose — the backend is agnostic of its public origin, so the client prefixes
    # its API base. The ``?v=`` is a content hash, so the cached <img> refreshes on
    # change. → see api/routes/users.py for the (public) serving endpoint.
    avatar_url: str | None = None

    @classmethod
    def from_user(cls, user: "User") -> "UserResponse":
        """Build the API view of a user row (the single source for this mapping)."""
        return cls(
            id=user.user_id,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            role=user.role,
            created_at=user.created_at,
            default_model_mode=user.default_model_mode,
            avatar_url=_avatar_url(user.user_id, user.avatar_key),
        )


class TokenResponse(BaseModel):
    """Bearer-token bundle for non-cookie clients (mobile web / Capacitor shell, M2).

    The cookie login (``/v1/auth/login``) keeps tokens in httpOnly cookies; this is
    its body-returning twin for clients whose origin (``capacitor://`` / a new web
    origin) can't rely on SameSite cookies (认证与会话.md §十). ``expires_in`` is the
    access token's lifetime in seconds so the client refreshes before it lapses;
    ``user`` rides the login response (identity in one round trip) and is omitted on
    refresh.
    """

    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserResponse | None = None


class TokenRefreshRequest(BaseModel):
    """Rotate a bearer client's token pair (refresh token in the body, not a cookie)."""

    refresh_token: str = Field(..., min_length=1, max_length=512)


class TokenRevokeRequest(BaseModel):
    """Bearer-client logout: revoke the presented refresh token's whole family."""

    refresh_token: str = Field(..., min_length=1, max_length=512)


class CreateInviteRequest(BaseModel):
    # None = never expires; otherwise the code is valid for this many days.
    expires_in_days: int | None = Field(None, ge=1, le=365)


class InviteResponse(BaseModel):
    id: str
    code: str
    # active = issuable; used = consumed (terminal); expired = lapsed unused;
    # revoked = retired by an admin before use (邀请码撤销).
    status: Literal["active", "used", "expired", "revoked"]
    created_by: str | None
    used_by: str | None
    created_at: datetime
    expires_at: datetime | None
    used_at: datetime | None
    revoked_at: datetime | None = None


class InviteListResponse(BaseModel):
    data: list[InviteResponse]
    total: int


# --- Admin (用户管理: 平台管理员后台, admin-only) ---


class AdminUserResponse(BaseModel):
    """A platform account as seen by the admin console (full record + quota state).

    Richer than ``UserResponse`` (the self-view): adds ``status`` and the per-user
    quota overrides so the operator can manage accounts. Each quota override is
    nullable — NULL = inherit the global config threshold for that dimension
    (成本配额与计费.md §一, 决策④); a value (incl. 0 = unlimited) overrides it.
    """

    id: str
    username: str
    display_name: str
    email: str | None
    role: Literal["user", "admin"]
    status: Literal["active", "disabled"]
    is_unlimited: bool
    quota_daily_tokens: int | None
    quota_monthly_cost_usd: float | None
    quota_daily_requests: int | None
    default_model_mode: str | None
    created_at: datetime
    # NULL for a live account; a timestamp marks a 注销 (self-service deleted +
    # anonymized) account. The roster hides these by default and renders them as
    # 「已注销」when surfaced — they're tombstones, not manageable accounts.
    deleted_at: datetime | None


class AdminUserListItem(AdminUserResponse):
    """A roster row: the account record + its all-time cumulative spend.

    Extends the account view with ``cost_total`` (all-time, integer nano-USD) so the
    用户管理 roster can both **sort by** and **display** per-user lifetime cost without a
    second round-trip. The client folds the response's ``cny_per_usd`` for ¥.
    """

    cost_total: int


class AdminUserListResponse(BaseModel):
    data: list[AdminUserListItem]
    total: int
    page: int
    page_size: int
    # FX rate to fold each row's nano-USD ``cost_total`` into ¥ (single source: config).
    cny_per_usd: float


class AdminUpdateUserRequest(BaseModel):
    """Partial update of a user's role / status / quota (admin console).

    Tri-state semantics key off which fields are *present* in the request body
    (Pydantic ``model_fields_set``), not their value:
    - field absent        → leave unchanged
    - quota field = null  → clear the override (inherit the global config)
    - quota field = value → set the override (0 = unlimited for that dimension)

    ``is_unlimited`` short-circuits all three quota dimensions for trusted
    accounts. Sending ``role``/``status`` that targets the caller's own account in
    a way that would revoke their own admin access is refused at the service layer
    (no self-lockout — the platform always keeps ≥1 active admin).
    """

    role: Literal["user", "admin"] | None = None
    status: Literal["active", "disabled"] | None = None
    is_unlimited: bool | None = None
    quota_daily_tokens: int | None = Field(None, ge=0)
    quota_monthly_cost_usd: float | None = Field(None, ge=0)
    quota_daily_requests: int | None = Field(None, ge=0)


class AdminResetPasswordResponse(BaseModel):
    """The one-off password minted by an admin reset (重置密码), returned exactly once.

    Plaintext is never persisted — only its hash. The admin hands this to the user,
    whose existing sessions are already revoked, so they must log in with it next.
    """

    temporary_password: str


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
    # workspace/mode is derived from its folder (文件夹即工作区); see 对话列表设计.
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
    # Sub-path within the bound local root (工作区对称化 D1a); None/"" = the root
    # itself (an explicitly-added local project). A non-empty segment marks a
    # per-conversation workspace lazily promoted under a shared container root —
    # the desktop binds its sidecar engine to ``local_root_id`` + this subpath so a
    # promoted bare chat's local engine runs in its own directory (§四).
    local_subpath: str | None = None
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
    # Sub-path within ``root_id`` this workspace lives at (工作区对称化 D1a). Set for a
    # per-conversation local workspace lazily promoted under a shared container root;
    # None for cloud and for explicitly-added local projects bound at their root. The
    # desktop browses ``root_id`` + ``subpath`` so each sub-workspace shows only its
    # own files.
    subpath: str | None = None
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
    # Desktop default local container root (工作区对称化 D1a). When a 裸聊's first
    # file lands, it is lazily promoted into a *local* workspace under this root (a
    # per-conversation subpath) instead of a cloud folder — keeping desktop and
    # cloud symmetric. None = web / mobile / explicit "云端临时对话" → cloud promote.
    # Opaque desktop FS-root handle (same trust model as ``local_root_id``); ignored
    # once the conversation already has a folder.
    local_container_root_id: str | None = Field(None, max_length=200)


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
        return CheckpointResponse(
            decision=body.decision, note=body.note, selected=body.selected
        )
    if isinstance(body, ResolvePlanReviewInteraction):
        return CheckpointResponse(decision=body.decision, note=body.note)
    if isinstance(body, ResolveClientToolInteraction):
        return {
            "ok": body.ok,
            "value": body.value,
            "error": body.error.model_dump() if body.error else None,
        }
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


class MessagePromptResponse(BaseModel):
    """The verbatim system prompt ONE assistant turn ran with (本回合提示词, 提示词透明).

    Surfaces the ``turn_started`` head fact captured in the turn journal (§18.3) — the
    exact CEO system prompt for that turn, dynamic bits (date / 能力目录 / attachments)
    and all. Read-only, owner-scoped; absent for user messages or legacy turns (404).
    """

    system_prompt: str


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
    # duplicate the user/assistant rows (双模式工作区 §一.1 回写可靠性). Optional for
    # back-compat; the desktop always sends it.
    user_message_id: str | None = Field(None, max_length=64)
    message_id: str | None = Field(None, max_length=64)
    input_tokens: int = Field(0, ge=0)
    output_tokens: int = Field(0, ge=0)
    rounds: int = Field(0, ge=0)


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


# --- Conversation shares (公开只读分享链接: 对标 ChatGPT 分享) ---


class ShareSummary(BaseModel):
    """One public read-only conversation share (分享链接).

    ``url`` is a RELATIVE path (``/shared/<id>``) — like ``UserResponse.avatar_url``,
    the client prepends the API origin so the backend stays agnostic of its public
    host. ``id`` is the management handle (used to revoke); it is also the URL token.
    """

    id: str
    url: str
    title: str
    created_at: datetime


class ShareListResponse(BaseModel):
    data: list[ShareSummary]
    total: int


# --- Push devices (原生推送设备注册: FCM token, 手机端落地设计 P2) ---


class DeviceRegistration(BaseModel):
    """A mobile client registering its push token (POST /v1/devices).

    ``platform`` is a closed set so a bad client can't seed an unroutable row; the
    backend currently delivers via FCM (Android + iOS-via-FCM), ``web`` is reserved.
    """

    token: str = Field(..., min_length=1, max_length=4096)
    platform: Literal["ios", "android", "web"]


class DeviceSummary(BaseModel):
    """One registered device (设备管理 / 测试用).

    Deliberately omits the raw ``token`` — it's a delivery secret, never echoed back.
    """

    id: str
    platform: str
    created_at: datetime


class DeviceListResponse(BaseModel):
    data: list[DeviceSummary]
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


class WorkspaceEditDoc(BaseModel):
    """Full text of a cloud workspace file for in-panel editing, plus CAS baseline.

    Unlike the preview download (truncated at the transfer cap), this returns the
    **whole** file so a save never drops the tail. ``mtime_ms`` is the write-time CAS
    baseline (compared on write); ``eol`` lets the editor restore the original line
    ending. Cloud files are server-stored UTF-8, so there is no encoding field.
    """

    text: str
    mtime_ms: int
    eol: Literal["lf", "crlf"]


class WorkspaceWriteRequest(BaseModel):
    """Conditional write of editor text to a cloud workspace file (mtime CAS).

    ``baseline_mtime_ms`` is the version the edit started from (``0`` = new file); a
    mismatch with the current disk mtime returns a conflict instead of clobbering an
    Agent's concurrent write. ``content`` uses ``\\n`` newlines; the server restores
    ``eol`` on write. Byte size is bounded in the route (same cap as upload).
    """

    content: str
    eol: Literal["lf", "crlf"] = "lf"
    baseline_mtime_ms: int = Field(0, ge=0)


class WorkspaceWriteResult(BaseModel):
    """Outcome of a conditional write.

    ``ok`` → ``mtime_ms`` is the new version (next baseline). On ``conflict`` →
    ``ok`` is False and ``mtime_ms`` is the **current disk** version, so the client
    can offer "overwrite anyway" by re-writing with it as the baseline.
    """

    ok: bool
    mtime_ms: int
    conflict: bool = False


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


# --- Capabilities (能力图鉴: the complete read-only picture of what agents can do) ---


class CapabilityTool(BaseModel):
    """A tool in the capability catalog: its public schema + who may call it.

    Unlike ``ToolInfo`` (the legacy worker-built-ins-only ``GET /tools``), this is the
    COMPLETE catalog — it also carries the CEO-only orchestration primitives
    (``delegate`` / ``revise`` / ``consult_skill`` / ``ask_user``) and the worker-only
    ``escalate``. ``available_to`` is a subset of ``["ceo", "worker"]`` so the UI can
    show which side of the team holds each tool.
    """

    name: str
    description: str
    category: ToolCategory
    approval: ToolApproval
    parameters: dict[str, Any]
    available_to: list[str]


class CapabilitySkill(BaseModel):
    """A system Skill in the catalog (渐进披露): its catalog ``summary`` (the always-on
    one-line trigger) plus the full ``body`` guidance the CEO pulls via consult_skill."""

    name: str
    summary: str
    body: str


class CapabilityGuidelines(BaseModel):
    """The system-prompt TEMPLATE the agents follow (静态 蓝图; the per-turn verbatim
    prompt is served separately, see the message prompt endpoint).

    ``shared_base`` is the base every agent (CEO + workers) shares (identity, output
    style, tool-use, safety); ``ceo`` is the CEO coordinator's full chat system-prompt
    template (shared base + CEO routing core + 能力目录 + citation guidance), composed by
    the SAME ``compose_ceo_chat_prompt`` the live turn uses, so it never drifts.
    """

    shared_base: str
    ceo: str


class CapabilitiesResponse(BaseModel):
    """The complete capability picture for the 能力图鉴 page (single fetch)."""

    tools: list[CapabilityTool]
    skills: list[CapabilitySkill]
    guidelines: CapabilityGuidelines


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


# --- Admin: 全站用量看板 (P1) + 系统状态 (P2) ---
# The cross-user counterparts of the per-user usage schemas above, plus a
# read-only deployment-status snapshot. Both endpoints are admin-gated
# (管理员后台.md); they reuse UsageWindow / DailyCost / QuotaStatus defined above.


class AdminUserCostLine(BaseModel):
    """One account's spend over a window — the platform 工资单 by user (全站看板).

    The cross-user counterpart of ``RoleCostLine``. Money is integer nano-USD; the
    client formats ¥ from the summary's single ``cny_per_usd`` (no re-pricing).
    """

    user_id: str
    username: str
    display_name: str
    cost_total: int
    # Distinct assistant turns this account ran over the window.
    turns: int


class AdminUsageSummary(BaseModel):
    """Platform-wide usage dashboard (``GET /v1/admin/usage/summary``, admin-only).

    The cross-user counterpart of ``UsageSummary``: today's / this month's totals
    aggregated over *every* account, the Top spenders by user (工资单 by user), and
    the 7-day platform trend. ``billing_mode`` is surfaced so the client frames cost
    honestly — in "byok" these totals are the sum of each user's spend on their
    *own* DeepSeek key (not platform-paid).
    """

    today: UsageWindow
    month: UsageWindow
    # This month's spend split by user (工资单 by user), spend-desc, >0 only, capped.
    month_by_user: list[AdminUserCostLine]
    # Last 7 UTC days incl today, oldest-first, zero-filled — the platform trend.
    recent_daily_cost: list[DailyCost]
    cny_per_usd: float
    billing_mode: str


class AdminSystemStatus(BaseModel):
    """Read-only platform status for the admin console (``GET /v1/admin/system``).

    A deployment sanity-check at a glance (管理员后台 P2): the billing mode + global
    quota defaults + FX rate (all deploy-time ``config``, not editable here),
    database reachability, build provenance, and account tallies. Everything is
    read-only — config changes go through env + redeploy, not the console.
    """

    billing_mode: str
    cny_per_usd: float
    # Global quota defaults (config); per-user overrides live on the user record.
    quota: QuotaStatus
    # A live ``SELECT 1`` round-trip succeeded within the probe timeout.
    database_ok: bool
    version: str
    git_sha: str
    built_at: str
    users_total: int
    users_active: int
    admins: int


# --- Admin: 运营观测看板 (观测, P1) ---
# The operator-facing health view, sourced from turn_metrics (the per-turn
# telemetry DB sink) rather than the dev log firehose (logs/dev.jsonl). Admin-gated
# (管理员后台.md). Per-turn money/text are NOT duplicated here — a 会话复盘 (P2)
# joins cost_events + messages by trace_id.


class TurnHealthWindow(BaseModel):
    """Turn health aggregated over a time window (today / 近 7 日) — 全站健康.

    Rates are derived server-side from the raw counts (the client renders them as
    percentages); ``p95_duration_ms`` surfaces the latency tail the average hides.
    """

    turns: int
    errors: int
    # errors / turns in 0..1 (0 when the window has no turns).
    error_rate: float
    avg_duration_ms: int
    p95_duration_ms: int
    avg_rounds: float
    # Turns that delegated to ≥1 member (multi-agent), and its share of turns.
    delegated_turns: int
    delegated_rate: float
    input_tokens: int
    output_tokens: int


class DailyTurns(BaseModel):
    """One UTC day's turn + error counts — a point in the 观测 trend."""

    # ISO date (YYYY-MM-DD) of the UTC calendar day.
    date: str
    turns: int
    errors: int


class TurnMetricLine(BaseModel):
    """One turn's telemetry row — the 近期错误 feed + 会话复盘 entry point.

    Carries the join keys (``trace_id`` / ``conversation_id``) to drill from a
    failure into the full turn (logs + messages + spend). ``error`` is the
    truncated soft-error text (NULL on success). Built straight from the ORM row.
    """

    turn_id: str
    conversation_id: str
    user_id: str
    agent_id: str | None
    trace_id: str | None
    kind: str
    status: str
    finish_reason: str | None
    error: str | None
    rounds: int
    duration_ms: int
    delegated: bool
    workers: int
    created_at: datetime

    model_config = {"from_attributes": True}


class AdminObservabilitySummary(BaseModel):
    """Platform-wide 运营观测看板 (``GET /v1/admin/observability/summary``, admin-only).

    The operator's health view, sourced from ``turn_metrics`` (not the dev log
    file): today's and the trailing 7-day window health, the 7-day daily trend, and
    the most recent errored turns. Aggregated over *every* account (admin is a
    cross-user surface). Per-turn money/text are NOT here — drill into a turn by
    ``trace_id`` (会话复盘, P2) to join cost_events + messages.
    """

    today: TurnHealthWindow
    week: TurnHealthWindow
    # Last 7 UTC days incl today, oldest-first, zero-filled — the trend bars.
    recent_daily: list[DailyTurns]
    # Most recent errored turns (newest-first, capped) — the 近期错误 feed.
    recent_errors: list[TurnMetricLine]


# --- Admin: 控制台概览 (landing dashboard) ---
# A curated one-call snapshot for the console home, stitched from the same
# aggregates as 用量 / 观测 / 系统 (one extra: distinct active users) so the
# headline numbers never drift from those drill-down pages.


class AdminOverview(BaseModel):
    """Landing dashboard (``GET /v1/admin/overview``, admin-only) — platform pulse.

    Today's vitals (active users / turn health / cost), account tallies, the 7-day
    cost + turn trends, deployment health, and the most recent errors (drillable
    into 会话复盘). Money is integer nano-USD; the client folds ``cny_per_usd`` for ¥.
    """

    # 今日 pulse: distinct users that took a turn, the turn-health rollup (turns /
    # errors / error_rate / p95 / 委派率 / tokens), and total spend today.
    active_users_today: int
    today: TurnHealthWindow
    cost_today: CostBreakdown
    # Account tallies (status-based, same source as 系统状态).
    users_total: int
    users_active: int
    admins: int
    # 7-day trends (oldest-first, zero-filled) — cost bars + turn/error bars.
    recent_daily_cost: list[DailyCost]
    recent_daily_turns: list[DailyTurns]
    # Deployment health + a short recent-errors feed (drill into 会话复盘 by id).
    database_ok: bool
    recent_errors: list[TurnMetricLine]
    cny_per_usd: float
    billing_mode: str


# --- Admin: 用户详情下钻 (用户管理 P0 drill-down) ---
# One account's at-a-glance profile: the full record + its *own* usage (the
# per-user counterpart of the platform 用量看板) + its recent conversations and
# turn activity (each drillable into 会话复盘). Admin cross-user, read-only.


class AdminConversationLine(BaseModel):
    """One of a user's conversations in the 用户详情 roster (compact row).

    id/title/timestamps + message count, newest-activity first. Links to the
    existing 会话复盘 (``GET /v1/admin/observability/conversations/{id}``) for the
    full merged timeline. ``title`` is NULL for an untitled conversation.
    """

    id: str
    title: str | None
    created_at: datetime
    updated_at: datetime
    # Total messages in the conversation (user + assistant).
    messages: int


class AdminUserDetail(BaseModel):
    """One account's drill-down (``GET /v1/admin/users/{id}/detail``, admin-only).

    Stitches the per-user views an operator needs to understand an account: the
    full record (``user``), this account's usage (today/month/trend/by-role — the
    per-user counterpart of ``AdminUsageSummary``, scoped via ``cost_events.user_id``),
    its recent conversations, and its recent turn activity (``turn_metrics``, each
    drillable into 会话复盘). Money is integer nano-USD; the client folds the single
    ``cny_per_usd`` for ¥. ``billing_mode`` frames cost honestly (byok = own-key spend).
    """

    user: AdminUserResponse
    today: UsageWindow
    month: UsageWindow
    # This month's spend split by role (团队工资单 by role), spend-desc, >0 only.
    month_by_role: list[RoleCostLine]
    # Last 7 UTC days incl today, oldest-first, zero-filled — the trend sparkline.
    recent_daily_cost: list[DailyCost]
    # Recent conversations (newest-activity first, capped).
    conversations: list[AdminConversationLine]
    # Recent turns (newest-first, capped) — each drillable into 会话复盘.
    recent_turns: list[TurnMetricLine]
    cny_per_usd: float
    billing_mode: str


class ReplaySpan(BaseModel):
    """One execution span inside a turn — a tool call or an LLM call — projected
    compactly from ``turn_journal`` for the 复盘 drill-down.

    Deliberately summary-only: NOT the heavy/sensitive replay payload (system
    prompts, full tool results), just what triages a turn — what ran, in which
    round/run, ok?, finish_reason, tokens, and a short preview. Per-span latency is
    omitted: the execution facts don't reliably carry a per-span timestamp yet.
    """

    kind: str  # "tool" | "llm"
    run_id: str | None = None
    round_idx: int | None = None
    # Tool spans:
    name: str | None = None
    success: bool | None = None
    args_preview: str | None = None
    result_preview: str | None = None
    # LLM spans:
    finish_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


class ReplayMessage(BaseModel):
    """One message in a 会话复盘 timeline (the thread + per-turn overlays).

    An assistant message carries its turn's telemetry (``metrics``, joined by
    trace_id), spend (``cost_total``, summed from cost_events by message_id), and the
    turn's execution spans (``spans``, projected from turn_journal); user messages
    have none. ``content`` is the raw message text (the prompt / reply) — the
    substance of the post-mortem.
    """

    id: str
    role: str
    content: str | None
    created_at: datetime
    trace_id: str | None
    metrics: TurnMetricLine | None = None
    # Per-turn spend (integer nano-USD); the client folds ``cny_per_usd`` for ¥.
    cost_total: int = 0
    # The turn's tool/LLM spans (turn_journal projection); empty for user prompts and
    # for turns that journaled nothing (a plain single-agent chat with no tools).
    spans: list[ReplaySpan] = []


class ReplayConversation(BaseModel):
    """The conversation header for a 复盘 (owner identity + title)."""

    id: str
    title: str | None
    user_id: str
    username: str | None
    display_name: str | None
    created_at: datetime


class AdminConversationReplay(BaseModel):
    """One conversation's 复盘 timeline (``GET /v1/admin/observability/conversations/{id}``).

    Merges the three turn sources by trace_id / message_id: the message thread
    (bodies, from ``messages``), per-turn outcome/quality (``turn_metrics``), and
    per-turn spend (``cost_events``). Admin-only, cross-user — the drill-down target
    of the 观测看板's 近期错误 feed (opens a failed turn in full context).
    """

    conversation: ReplayConversation
    messages: list[ReplayMessage]
    # Conversation rollup over its traced turns.
    turns: int
    errors: int
    # Total turn spend (integer nano-USD) + the single FX rate for ¥ display.
    cost_total: int
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
    """Send a message into a chat: plain text, or a 富消息 carrying attachments.

    ``content`` is optional when ``attachments`` is non-empty (an image/file-only
    message has no caption); otherwise it is required. ``content_type`` tells the
    client how to render it — ``image`` for an inline gallery, ``file`` for
    download chips — and is derived by the sender from what it uploaded.
    """

    content: str | None = Field(None, max_length=32000)
    content_type: Literal["text", "image", "file"] = "text"
    # Pre-uploaded via PUT /messages/chats/{id}/files/{path}; referenced here by
    # their returned workspace paths. Capped low (a single message, not a folder).
    attachments: list[StoredAttachment] = Field(default_factory=list, max_length=9)
    # Client-minted id for retry-safe idempotent send (dedup at the unique index).
    client_msg_id: str | None = Field(None, max_length=100)
    reply_to_message_id: str | None = Field(None, max_length=64)

    @model_validator(mode="after")
    def _require_content_or_attachments(self) -> "SendChatMessageRequest":
        if not (self.content and self.content.strip()) and not self.attachments:
            raise ValueError("消息内容与附件不能同时为空")
        return self


class ChatFileUploadResponse(BaseModel):
    """Result of a chat attachment upload (Stage 4 富消息).

    Mirrors ``UploadFileResponse`` but adds ``thumb_path``: a generated WebP
    thumbnail's workspace path for images (None otherwise), which the sender
    copies onto the message's ``StoredAttachment`` for cheap inline previews.
    """

    path: str
    size_bytes: int
    thumb_path: str | None = None


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


# --- File assist (AI 改写) ---


class RewriteRequest(BaseModel):
    """选区改写入参（无状态、无路径）：把选中文本按指令改写，前后文仅作语境只读。"""

    # 选中文本：必填。上限约束 LLM 成本，单段散文/小节足够；超大选区由前端切分或拒绝。
    selection: str = Field(..., min_length=1, max_length=20000)
    instruction: str = Field(..., min_length=1, max_length=2000)
    # 选区前/后的上下文，给模型衔接语气/术语用——只读，绝不参与改写输出。
    context_before: str = Field("", max_length=4000)
    context_after: str = Field("", max_length=4000)


class RewriteResponse(BaseModel):
    """改写结果：替换选区的文本，由前端套 merge view 逐块评审（人决定接受/拒绝）。"""

    rewritten: str


# --- Generic ---


class StatusResponse(BaseModel):
    status: str = "ok"
