"""Conversation and folder (sidebar grouping) request/response schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


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
    # Desktop's default local container root (工作区对称化 D1a), captured at creation so
    # locality is decided once. When set (and the chat is born ungrouped), its first
    # file write — Agent turn OR panel op — lazily promotes it into a *local* workspace
    # under this root instead of a cloud folder, so both promotion paths agree. None =
    # cloud intent (web / mobile /「云端临时对话」). Opaque desktop FS-root handle; moot
    # when ``folder_id`` is set (a foldered chat inherits its folder's binding).
    local_container_root_id: str | None = Field(None, max_length=200)


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
    # Desktop's stored local-first intent (工作区对称化 D1a), echoed so the client can
    # decide a **裸聊's** panel transport the same way the server decides promotion: set
    # (and ``folder_id`` still None) ⇒ desktop's first panel write goes via IPC and
    # lazily promotes a *local* workspace (a client-side mirror of ``DeferredWorkspace``),
    # rather than the cloud REST source which would mis-write a local folder server-side.
    # None ⇒ cloud intent; moot once foldered (the folder's own binding governs).
    local_container_root_id: str | None = None
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
