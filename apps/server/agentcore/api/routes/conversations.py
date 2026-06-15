"""Conversation CRUD and message sending routes.

Every route requires an authenticated user and is scoped to that user's own
conversations: reads/writes pass ``user_id`` into the repository so a non-owner
receives 404 (never another user's data — IDOR-safe).
"""

import asyncio
import mimetypes

from fastapi import APIRouter, Depends, Query, Request, Response

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_cost_event_repo,
    get_folder_repo,
    get_handoff_job_repo,
    get_message_repo,
)
from agentcore.api.schemas import (
    ApplyHandoffRequest,
    BindLocalWorkspaceRequest,
    CloneRepoRequest,
    CloneRepoResponse,
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    CreateDirRequest,
    CreateSnapshotRequest,
    DispatchHandoffRequest,
    FolderGroup,
    GroupedConversationsResponse,
    HandoffDiffResponse,
    HandoffFileChange,
    HandoffJobListResponse,
    HandoffJobSummary,
    MessageDetail,
    MessageListResponse,
    MoveConversationRequest,
    MoveFileRequest,
    RegenerateMessageRequest,
    ResolveApprovalRequest,
    ResolveWorkspaceOpRequest,
    SendMessageRequest,
    SnapshotListResponse,
    SnapshotSummary,
    StatusResponse,
    UpdateConversationRequest,
    UploadFileResponse,
    WorkspaceBindingResponse,
    WorkspaceFileEntry,
    WorkspaceFileListResponse,
)
from agentcore.api.sse import sse_response
from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.conversation.rate_limit import enforce_user_message_rate_limit
from agentcore.conversation.service import (
    dispatch_handoff,
    regenerate_chat,
    stream_chat,
)
from agentcore.core.errors import ConflictError, NotFoundError, ValidationError
from agentcore.db.models import Conversation
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    FolderRepository,
    HandoffJobRepository,
    MessageRepository,
)
from agentcore.core.logging import get_logger
from agentcore.runtime.approvals import default_approval_registry
from agentcore.runtime.events import (
    EventSink,
    error_event,
    handoff_apply_done,
    handoff_snapshot_done,
)
from agentcore.storage import SnapshotNotFound
from agentcore.workspace.channel import default_workspace_op_registry
from agentcore.workspace.handoff import snapshot_local
from agentcore.workspace.handoff_apply import ApplySelection, apply_handoff
from agentcore.workspace.handoff_diff import compute_handoff_diff
from agentcore.workspace.files import (
    create_dir,
    delete_file,
    download_file,
    list_files,
    move_file,
    upload_file,
)
from agentcore.workspace.git import CloneError, clone_repo
from agentcore.workspace.locate import (
    LocalBinding,
    build_workspace,
    resolve_local_binding,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import (
    AlreadyExists,
    NotAFile,
    OutsideWorkspace,
    PathNotFound,
)
from agentcore.workspace.snapshots import (
    create_snapshot,
    list_snapshots,
    read_snapshot,
    restore_snapshot,
)

router = APIRouter(prefix="/conversations", tags=["conversations"])

logger = get_logger(__name__)


async def _require_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> None:
    """404 unless the conversation exists and belongs to the user."""
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("Conversation not found")


def _summary_with_count(
    conv: Conversation, counts: dict[str, int]
) -> ConversationSummary:
    """Build a conversation summary, filling ``message_count`` from a counts map.

    The list/grouped endpoints precompute counts in one query (see
    ``MessageRepository.counts_for_conversations``) and pass the map here so the
    sidebar gets each chat's count without an N+1; absent ids default to 0.
    """
    summary = ConversationSummary.model_validate(conv)
    summary.message_count = counts.get(conv.id, 0)
    return summary


async def _get_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> Conversation:
    """Return the conversation (for its ``folder_id``) or 404 if not owned.

    Snapshot routes need ``folder_id`` to resolve the right workspace: a folder's
    conversations share its space; an ungrouped one has its own (workspace.locate).
    """
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    return conv


def _binding_response(
    conv: Conversation, folder: object | None
) -> WorkspaceBindingResponse:
    """Render a conversation's resolved workspace mode (§七) as the API response.

    ``scope`` reports where the binding lives — the folder for a filed
    conversation (shared by its siblings), the conversation itself otherwise — so
    the client knows whether unbinding would affect other chats.
    """
    scope = "folder" if conv.folder_id else "conversation"
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=getattr(folder, "local_root_id", None),
        conversation_local_root_id=conv.local_root_id,
    )
    if binding is None:
        return WorkspaceBindingResponse(mode="cloud", scope=scope, root_id=None)
    return WorkspaceBindingResponse(mode="local", scope=scope, root_id=binding.root_id)


@router.post("", response_model=ConversationSummary, status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    # A non-null target folder must be one of the user's own live folders (else
    # 404), mirroring the move endpoint so a chat can never be born in someone
    # else's or a deleted folder.
    if body.folder_id is not None:
        folder = await folder_repo.get_by_id(body.folder_id, user_id=user.user_id)
        if not folder:
            raise NotFoundError("Folder not found")
    conv = await repo.create(
        user_id=user.user_id, title=body.title, folder_id=body.folder_id
    )
    return ConversationSummary.model_validate(conv)


@router.get("", response_model=ConversationListResponse)
async def list_conversations(
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    repo: ConversationRepository = Depends(get_conversation_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    offset = (page - 1) * page_size
    conversations, total = await repo.list_by_user(
        user.user_id, limit=page_size, offset=offset
    )
    counts = await msg_repo.counts_for_conversations([c.id for c in conversations])
    return ConversationListResponse(
        data=[_summary_with_count(c, counts) for c in conversations],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/grouped", response_model=GroupedConversationsResponse)
async def list_conversations_grouped(
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    """Folders + their conversations + the ungrouped remainder (sidebar).

    Declared before ``/{conversation_id}`` so "grouped" isn't captured as an id.
    A conversation whose folder is missing/deleted falls back to ungrouped.
    """
    folders = await folder_repo.list_by_user(user.user_id)
    conversations = await conv_repo.list_all_by_user(user.user_id)
    counts = await msg_repo.counts_for_conversations([c.id for c in conversations])

    buckets: dict[str, list[ConversationSummary]] = {f.id: [] for f in folders}
    ungrouped: list[ConversationSummary] = []
    for conv in conversations:
        summary = _summary_with_count(conv, counts)
        if conv.folder_id in buckets:
            buckets[conv.folder_id].append(summary)
        else:
            ungrouped.append(summary)

    return GroupedConversationsResponse(
        folders=[
            FolderGroup(
                id=f.id,
                name=f.name,
                local_dir=f.local_dir,
                local_root_id=f.local_root_id,
                conversations=buckets[f.id],
            )
            for f in folders
        ],
        ungrouped=ungrouped,
    )


@router.get("/{conversation_id}", response_model=ConversationSummary)
async def get_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    return ConversationSummary.model_validate(conv)


@router.patch("/{conversation_id}", response_model=ConversationSummary)
async def update_conversation(
    conversation_id: str,
    body: UpdateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    if body.title is not None:
        conv = await repo.update_title(conversation_id, body.title, user_id=user.user_id)
    else:
        conv = await repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    return ConversationSummary.model_validate(conv)


@router.patch("/{conversation_id}/folder", response_model=ConversationSummary)
async def move_conversation_to_folder(
    conversation_id: str,
    body: MoveConversationRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
    msg_repo: MessageRepository = Depends(get_message_repo),
):
    """Move a conversation into a folder, or out of one (``folder_id=null``).

    A non-null target must be one of the user's own live folders (else 404), so
    a chat can never be filed into someone else's or a deleted folder.

    A conversation's workspace is fixed once it starts (双模式工作区 §九 ⑩): its
    folder decides which workspace directory it runs in — and whether cloud or
    local — so moving a *started* chat across folders would silently re-point it at
    a different directory and orphan its accumulated files. Such a move is refused
    with 409; only an unsent (zero-message) chat is freely fileable. A no-op move
    (already in the target) never changes the workspace, so it is always allowed.
    """
    conv = await conv_repo.get_by_id(conversation_id, user_id=user.user_id)
    if not conv:
        raise NotFoundError("Conversation not found")
    if conv.folder_id != body.folder_id:
        if body.folder_id is not None:
            folder = await folder_repo.get_by_id(body.folder_id, user_id=user.user_id)
            if not folder:
                raise NotFoundError("Folder not found")
        if await msg_repo.count_by_conversation(conversation_id) > 0:
            raise ConflictError("对话开始后不可更换工作区")
        conv = await conv_repo.set_folder(
            conversation_id, body.folder_id, user_id=user.user_id
        )
        if not conv:
            raise NotFoundError("Conversation not found")
    return ConversationSummary.model_validate(conv)


@router.delete("/{conversation_id}", response_model=StatusResponse)
async def delete_conversation(
    conversation_id: str,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    deleted = await repo.soft_delete(conversation_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("Conversation not found")
    return StatusResponse()


@router.get("/{conversation_id}/messages", response_model=MessageListResponse)
async def list_messages(
    conversation_id: str,
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    repo: MessageRepository = Depends(get_message_repo),
):
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    offset = (page - 1) * page_size
    messages, total = await repo.list_by_conversation(
        conversation_id, limit=page_size, offset=offset
    )
    return MessageListResponse(
        data=[MessageDetail.model_validate(m) for m in messages],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Send a user message and get a streaming AI response via SSE.

    The pipeline runs as a detached task feeding ``sink``; its handle is passed
    to ``sse_response`` so a client disconnect (e.g. the user hits stop) cancels
    it server-side rather than letting it run to completion unobserved.

    Gated before the stream starts (成本配额与计费.md §一) so a refused turn gets a
    clean 429 instead of a half-opened SSE: per-user rate limit first (sheds a
    flooding account before any resource DB work), then ownership, then quota.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))

    sink = EventSink()

    task = asyncio.create_task(
        stream_chat(
            conversation_id=conversation_id,
            user_message=body.content,
            user_id=user.user_id,
            sink=sink,
            attachments=[a.model_dump() for a in body.attachments],
        )
    )

    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/approvals/{approval_id}", response_model=StatusResponse)
async def resolve_approval(
    conversation_id: str,
    approval_id: str,
    body: ResolveApprovalRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Authorize or deny a paused GRANTABLE tool call (tool approval gate).

    The pending tool call (in the live ``send_message`` SSE stream) resumes with
    the decision. 404 if the approval is unknown, already settled, timed out, or
    belongs to another conversation — the gate auto-denies anything left
    unanswered, so a stale prompt resolves as "not found".
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    resolved = default_approval_registry().resolve(
        approval_id, body.decision, conversation_id=conversation_id
    )
    if not resolved:
        raise NotFoundError("Approval request not found or already resolved")
    return StatusResponse()


@router.post(
    "/{conversation_id}/workspace/ops/{request_id}", response_model=StatusResponse
)
async def resolve_workspace_op(
    conversation_id: str,
    request_id: str,
    body: ResolveWorkspaceOpRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Deliver a desktop's result for a paused local-workspace op (双模式工作区 P2).

    The bound desktop client ran the op (read / list / grep / …) against the real
    local directory and posts the structured result here; the ``LocalWorkspace``
    awaiting it in the live ``send_message`` SSE turn resumes. 404 if the request
    is unknown, already settled, timed out, or belongs to another conversation —
    the channel fails any op left unanswered, so a stale post resolves as "not
    found".
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    resolved = default_workspace_op_registry().resolve(
        request_id,
        body.model_dump(),
        conversation_id=conversation_id,
    )
    if not resolved:
        raise NotFoundError("Workspace op request not found or already resolved")
    return StatusResponse()


# --- Local-mode binding (双模式工作区 §七: 模式跟着文件在哪自动走) ---


@router.get(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def get_workspace_binding(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Report a conversation's resolved workspace mode (local vs cloud).

    Backs the desktop's mode badge: cloud by default, local once its governing
    scope (folder when filed, else the conversation) is bound to a desktop root.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    return _binding_response(conv, folder)


@router.put(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def bind_workspace(
    conversation_id: str,
    body: BindLocalWorkspaceRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Bind the conversation's workspace to a desktop FS root (switch to local).

    Writes at the governing scope (§七): a filed conversation binds its *folder*
    (so every sibling switches to local against the same root), an ungrouped one
    binds itself. Idempotent — re-binding just overwrites the stored root id.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id:
        folder = await folder_repo.set_local_root_id(
            conv.folder_id, body.root_id, user_id=user.user_id
        )
        if not folder:
            raise NotFoundError("Folder not found")
        return WorkspaceBindingResponse(
            mode="local", scope="folder", root_id=body.root_id
        )
    await conv_repo.set_local_root_id(
        conversation_id, body.root_id, user_id=user.user_id
    )
    return WorkspaceBindingResponse(
        mode="local", scope="conversation", root_id=body.root_id
    )


@router.delete(
    "/{conversation_id}/workspace/binding", response_model=WorkspaceBindingResponse
)
async def unbind_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Unbind the conversation's workspace (fall back to cloud).

    Clears the binding at the same governing scope binding does: clearing a
    *folder* binding returns every conversation in it to cloud (it is the shared
    project space), which the ``folder`` scope in the response signals.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id:
        folder = await folder_repo.set_local_root_id(
            conv.folder_id, None, user_id=user.user_id
        )
        if not folder:
            raise NotFoundError("Folder not found")
        return WorkspaceBindingResponse(mode="cloud", scope="folder", root_id=None)
    await conv_repo.set_local_root_id(conversation_id, None, user_id=user.user_id)
    return WorkspaceBindingResponse(
        mode="cloud", scope="conversation", root_id=None
    )


async def _run_handoff(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    binding: LocalBinding,
    sink: EventSink,
) -> None:
    """Drive a local→云 handoff snapshot to completion over its SSE sink (P2e / e1).

    Mirrors ``stream_chat``'s shape: the ARCHIVE op is emitted on ``sink`` (the
    bound desktop fulfils it via the ops resolve endpoint), and on success a
    ``handoff_snapshot_done`` carrying the new snapshot id is emitted before the
    stream closes. Any failure is surfaced as an inline ``error`` event (never an
    unhandled crash on this detached task), so the client always learns the outcome.
    """
    try:
        ref = await snapshot_local(
            user_id=user_id,
            folder_id=folder_id,
            conversation_id=conversation_id,
            binding=binding,
            sink=sink,
        )
        sink.emit(
            handoff_snapshot_done(
                snapshot_id=ref.snapshot_id,
                conversation_id=conversation_id,
                size_bytes=ref.size_bytes,
            )
        )
    except Exception as e:
        logger.warning("handoff_failed", conversation_id=conversation_id, error=str(e))
        sink.emit(error_event("HANDOFF_FAILED", str(e)))
    finally:
        if not sink._closed:
            sink.close()


@router.post("/{conversation_id}/workspace/handoff")
async def handoff_local_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Snapshot a local-mode workspace to the cloud over the channel (双模式工作区 P2e / e1).

    Local-mode files live on the user's machine, so the post-turn OSS backup skips
    them; this is the explicit, on-demand 本地→云 snapshot (§四). Streams SSE: a
    ``workspace_op_required`` (the ARCHIVE op) the bound desktop fulfils, then a
    ``handoff_snapshot_done`` carrying the new snapshot id (it lands in the same
    snapshot list / restore / download as cloud-mode versions). 422 when the
    conversation is not in local mode — a cloud workspace already snapshots itself,
    and there is nothing on the user's disk to fetch.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        conversation_local_root_id=conv.local_root_id,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("Conversation is not in local mode")

    sink = EventSink()
    task = asyncio.create_task(
        _run_handoff(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            binding=binding,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/workspace/handoff/dispatch")
async def dispatch_handoff_job(
    conversation_id: str,
    body: DispatchHandoffRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Hand a task off to a cloud team seeded from the local workspace (P2e / e2).

    The 本地→云 交接 (§四): snapshot the user's local files, then run an Agent team on
    that snapshot in the cloud — autonomously, in the background — so a parallel team
    is not bottlenecked by the single desktop channel. Streams SSE: a
    ``workspace_op_required`` (the ARCHIVE op) the bound desktop fulfils, then a
    ``handoff_job_started`` carrying the job id; the cloud run continues detached
    after the stream closes (poll ``GET …/handoff/jobs`` for its status). 422 when
    the conversation is not in local mode (nothing local to hand off).

    Gated like ``send_message`` (it spends tokens): rate limit → ownership → quota.
    """
    await enforce_user_message_rate_limit(user.user_id)
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))

    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        conversation_local_root_id=conv.local_root_id,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("Conversation is not in local mode")

    sink = EventSink()
    task = asyncio.create_task(
        dispatch_handoff(
            conversation_id=conversation_id,
            user_id=user.user_id,
            folder_id=conv.folder_id,
            binding=binding,
            task=body.task,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.get("/{conversation_id}/handoff/jobs", response_model=HandoffJobListResponse)
async def list_handoff_jobs(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """A conversation's local→云 handoff jobs, newest first (双模式工作区 P2e / e2).

    Backs the client's job badge / PR list: poll this to learn when a dispatched
    cloud run finishes (status succeeded / failed). 404 if the conversation is not
    owned.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    jobs = await job_repo.list_for_source(conversation_id, user_id=user.user_id)
    data = [HandoffJobSummary.model_validate(j) for j in jobs]
    return HandoffJobListResponse(data=data, total=len(data))


@router.get(
    "/{conversation_id}/handoff/jobs/{job_id}", response_model=HandoffJobSummary
)
async def get_handoff_job(
    conversation_id: str,
    job_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """One handoff job's status + result snapshots (双模式工作区 P2e / e2).

    404 if the conversation is not owned, or the job is unknown / belongs to a
    different source conversation.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("Handoff job not found")
    return HandoffJobSummary.model_validate(job)


@router.get(
    "/{conversation_id}/handoff/jobs/{job_id}/diff",
    response_model=HandoffDiffResponse,
)
async def get_handoff_job_diff(
    conversation_id: str,
    job_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
):
    """A finished handoff's result diff — the change set for the local apply (P2e / e3).

    Compares the team's result snapshot against the base it ran on and returns the
    per-file change set (added / modified / deleted) the desktop replays onto the
    user's local files; each entry carries the base hash for the client's three-way
    conflict check (clean / already-applied / conflict). 404 if the conversation is
    not owned or the job is unknown / from another source conversation; 409 while the
    job has not succeeded yet (no result to diff).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("Handoff job not found")
    if job.status != "succeeded" or not job.result_snapshot_id:
        raise ConflictError("Handoff job has not produced a result yet")
    try:
        changes = await compute_handoff_diff(
            user_id=user.user_id,
            source_folder_id=conv.folder_id,
            source_conversation_id=conversation_id,
            base_snapshot_id=job.base_snapshot_id,
            job_conversation_id=job.job_conversation_id,
            result_snapshot_id=job.result_snapshot_id,
        )
    except SnapshotNotFound as e:
        raise NotFoundError("Handoff snapshot not found") from e
    data = [HandoffFileChange.model_validate(c) for c in changes]
    return HandoffDiffResponse(
        job_id=job.id,
        data=data,
        total=len(data),
        added=sum(1 for c in data if c.change_type == "added"),
        modified=sum(1 for c in data if c.change_type == "modified"),
        deleted=sum(1 for c in data if c.change_type == "deleted"),
    )


async def _run_apply(
    *,
    user_id: str,
    source_folder_id: str | None,
    source_conversation_id: str,
    job_id: str,
    job_conversation_id: str,
    base_snapshot_id: str,
    result_snapshot_id: str,
    binding: LocalBinding,
    selections: list[ApplySelection],
    sink: EventSink,
) -> None:
    """Drive a handoff result apply to completion over its SSE sink (P2e / e3).

    Builds the desktop-backed ``LocalWorkspace`` over this stream, then replays the
    accepted changes onto the user's machine (WRITE_BYTES / DELETE the bound desktop
    fulfils). On success a ``handoff_apply_done`` carrying the per-file outcomes is
    emitted before the stream closes; a missing snapshot or any failure surfaces as
    an inline ``error`` event (never an unhandled crash on this detached task).
    """
    try:
        backend = build_workspace(
            user_id=user_id,
            folder_id=source_folder_id,
            conversation_id=source_conversation_id,
            sink=sink,
            local_binding=binding,
        )
        outcomes = await apply_handoff(
            backend=backend,
            user_id=user_id,
            source_folder_id=source_folder_id,
            source_conversation_id=source_conversation_id,
            base_snapshot_id=base_snapshot_id,
            job_conversation_id=job_conversation_id,
            result_snapshot_id=result_snapshot_id,
            selections=selections,
        )
        sink.emit(
            handoff_apply_done(
                job_id=job_id,
                conversation_id=source_conversation_id,
                results=[o.to_dict() for o in outcomes],
            )
        )
    except SnapshotNotFound as e:
        logger.warning(
            "handoff_apply_snapshot_missing",
            conversation_id=source_conversation_id,
            error=str(e),
        )
        sink.emit(error_event("HANDOFF_SNAPSHOT_NOT_FOUND", str(e)))
    except Exception as e:
        logger.warning(
            "handoff_apply_failed",
            conversation_id=source_conversation_id,
            error=str(e),
        )
        sink.emit(error_event("HANDOFF_APPLY_FAILED", str(e)))
    finally:
        if not sink._closed:
            sink.close()


@router.post("/{conversation_id}/handoff/jobs/{job_id}/apply")
async def apply_handoff_job(
    conversation_id: str,
    job_id: str,
    body: ApplyHandoffRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    job_repo: HandoffJobRepository = Depends(get_handoff_job_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Apply a finished handoff's selected changes back to the local workspace (P2e / e3).

    The last leg of the 本地→云 round trip: the user's per-file decisions (take cloud /
    keep local, with the locally-observed hash) are replayed onto their machine over
    the channel. Streams SSE: ``workspace_op_required`` (WRITE_BYTES / DELETE) the
    bound desktop fulfils, then a ``handoff_apply_done`` with the per-file outcomes.
    The conflict gate is server-authoritative — a file that diverged locally since the
    base is refused (status ``conflict``) unless its selection ``force``\\s it.

    404 if the conversation is not owned or the job is unknown / from another source;
    409 while the job has not succeeded yet; 422 when the conversation is not in local
    mode (nothing local to apply onto).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    job = await job_repo.get_by_id(job_id, user_id=user.user_id)
    if job is None or job.source_conversation_id != conversation_id:
        raise NotFoundError("Handoff job not found")
    if job.status != "succeeded" or not job.result_snapshot_id:
        raise ConflictError("Handoff job has not produced a result yet")

    folder = (
        await folder_repo.get_by_id(conv.folder_id, user_id=user.user_id)
        if conv.folder_id
        else None
    )
    binding = resolve_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        conversation_local_root_id=conv.local_root_id,
        label=folder.name if folder else None,
    )
    if binding is None:
        raise ValidationError("Conversation is not in local mode")

    selections = [
        ApplySelection(
            path=s.path, decision=s.decision, local_sha=s.local_sha, force=s.force
        )
        for s in body.selections
    ]
    sink = EventSink()
    task = asyncio.create_task(
        _run_apply(
            user_id=user.user_id,
            source_folder_id=conv.folder_id,
            source_conversation_id=conversation_id,
            job_id=job.id,
            job_conversation_id=job.job_conversation_id,
            base_snapshot_id=job.base_snapshot_id,
            result_snapshot_id=job.result_snapshot_id,
            binding=binding,
            selections=selections,
            sink=sink,
        )
    )
    return sse_response(sink, producer=task)


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    cost_repo: CostEventRepository = Depends(get_cost_event_repo),
):
    """Re-run a turn from an existing user message via SSE.

    Serves both "regenerate" (no body content — reuse the stored user text) and
    "edit & resend" (``content`` set — edit the user message first). The target
    ``message_id`` must be a user message; the superseded assistant reply and any
    later turns are dropped before re-running. Like ``send_message``, the pipeline
    runs as a detached task so a client disconnect cancels it server-side. A
    re-run is a fresh turn, so it passes the same gates (rate limit → ownership →
    quota) as ``send_message``.
    """
    await enforce_user_message_rate_limit(user.user_id)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))

    sink = EventSink()

    task = asyncio.create_task(
        regenerate_chat(
            conversation_id=conversation_id,
            message_id=message_id,
            user_id=user.user_id,
            sink=sink,
            edited_content=body.content,
        )
    )

    return sse_response(sink, producer=task)


# --- Workspace snapshots (axis-3 persistence: backup / kept versions / download) ---


@router.get("/{conversation_id}/snapshots", response_model=SnapshotListResponse)
async def list_conversation_snapshots(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List the conversation's workspace snapshots (newest first)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    refs = await list_snapshots(
        user_id=user.user_id,
        folder_id=conv.folder_id,
        conversation_id=conversation_id,
    )
    return SnapshotListResponse(
        data=[SnapshotSummary.model_validate(r) for r in refs],
        total=len(refs),
    )


@router.post(
    "/{conversation_id}/snapshots", response_model=SnapshotSummary, status_code=201
)
async def create_conversation_snapshot(
    conversation_id: str,
    body: CreateSnapshotRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Take a manual snapshot of the workspace (a ``label`` keeps it as a version)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    # Folder lock (决策④): serialize the manifest write against a running turn's
    # auto-snapshot and other same-workspace mutations.
    async with workspace_lock(key):
        ref = await create_snapshot(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            label=body.label,
        )
    return SnapshotSummary.model_validate(ref)


@router.post(
    "/{conversation_id}/snapshots/{snapshot_id}/restore", response_model=StatusResponse
)
async def restore_conversation_snapshot(
    conversation_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Restore the workspace to a snapshot (overwrites current files)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    # Folder lock (决策④): a restore rewrites the whole workspace, so it must not
    # interleave with a running turn or another mutation on the same space.
    try:
        async with workspace_lock(key):
            await restore_snapshot(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                snapshot_id=snapshot_id,
            )
    except SnapshotNotFound as e:
        raise NotFoundError("Snapshot not found") from e
    return StatusResponse()


@router.get("/{conversation_id}/snapshots/{snapshot_id}/download")
async def download_conversation_snapshot(
    conversation_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Download a snapshot archive (zip) of the workspace at that point in time."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    try:
        data = await read_snapshot(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            snapshot_id=snapshot_id,
        )
    except SnapshotNotFound as e:
        raise NotFoundError("Snapshot not found") from e
    filename = f"workspace-{snapshot_id}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# --- Workspace files (bring files in / take results out: 文件进出·先上传) ---


@router.get("/{conversation_id}/workspace/files", response_model=WorkspaceFileListResponse)
async def list_workspace_files(
    conversation_id: str,
    user: AuthUser,
    recursive: bool = Query(False),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List the files in the conversation's workspace (top level or recursive)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    entries = await list_files(
        user_id=user.user_id,
        folder_id=conv.folder_id,
        conversation_id=conversation_id,
        recursive=recursive,
    )
    return WorkspaceFileListResponse(
        data=[WorkspaceFileEntry.model_validate(e) for e in entries],
        total=len(entries),
    )


@router.put(
    "/{conversation_id}/workspace/files/{path:path}", response_model=UploadFileResponse
)
async def upload_workspace_file(
    conversation_id: str,
    path: str,
    request: Request,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Upload (create/overwrite) a workspace file from the raw request body.

    The body is the file bytes (no multipart); ``path`` is the workspace-relative
    target. Bounded by ``workspace_upload_max_bytes`` so one request can't exhaust
    memory. A path that escapes the workspace is rejected (422).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)

    max_bytes = settings.workspace_upload_max_bytes
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise ValidationError(f"File exceeds the {max_bytes}-byte upload limit")
    data = await request.body()
    if len(data) > max_bytes:
        raise ValidationError(f"File exceeds the {max_bytes}-byte upload limit")

    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the write against a running same-folder turn.
        async with workspace_lock(key):
            written = await upload_file(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                path=path,
                data=data,
            )
    except OutsideWorkspace as e:
        raise ValidationError("Invalid path: outside the workspace") from e
    return UploadFileResponse(path=path, size_bytes=written)


@router.get("/{conversation_id}/workspace/files/{path:path}")
async def download_workspace_file(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Download a single file from the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    try:
        data = await download_file(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("Invalid path: outside the workspace") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("File not found") from e

    filename = path.rsplit("/", 1)[-1] or "download"
    media_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.delete(
    "/{conversation_id}/workspace/files/{path:path}", response_model=StatusResponse
)
async def delete_workspace_file(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Delete a file or directory from the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the delete against a running same-folder turn.
        async with workspace_lock(key):
            await delete_file(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                path=path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("Invalid path: outside the workspace") from e
    except PathNotFound as e:
        raise NotFoundError("File not found") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/move", response_model=StatusResponse)
async def move_workspace_file(
    conversation_id: str,
    body: MoveFileRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Move/rename a file or directory within the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize the move against a running same-folder turn.
        async with workspace_lock(key):
            await move_file(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                src=body.src,
                dst=body.dst,
            )
    except OutsideWorkspace as e:
        raise ValidationError("Invalid path: outside the workspace") from e
    except PathNotFound as e:
        raise NotFoundError("File not found") from e
    except AlreadyExists as e:
        raise ValidationError("A file with that name already exists") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/dirs", response_model=StatusResponse)
async def create_workspace_dir(
    conversation_id: str,
    body: CreateDirRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Create a directory in the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): serialize against a running same-folder turn.
        async with workspace_lock(key):
            await create_dir(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                path=body.path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("Invalid path: outside the workspace") from e
    except AlreadyExists as e:
        raise ValidationError("A file or folder with that name already exists") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/clone", response_model=CloneRepoResponse)
async def clone_repo_into_workspace(
    conversation_id: str,
    body: CloneRepoRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Clone a public git repository into the conversation's workspace (决策⑤)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    key = workspace_storage_key(
        user_id=user.user_id, folder_id=conv.folder_id, conversation_id=conversation_id
    )
    try:
        # Folder lock (决策④): the clone writes many files; serialize it against a
        # running same-folder turn and other workspace mutations.
        async with workspace_lock(key):
            dest = await clone_repo(
                user_id=user.user_id,
                folder_id=conv.folder_id,
                conversation_id=conversation_id,
                repo_url=body.repo_url,
                dest=body.dest,
            )
    except ValueError as e:
        raise ValidationError(str(e)) from e
    except CloneError as e:
        raise ValidationError(f"Clone failed: {e}") from e
    return CloneRepoResponse(path=dest)
