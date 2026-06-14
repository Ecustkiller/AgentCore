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
    get_folder_repo,
    get_message_repo,
)
from agentcore.api.schemas import (
    CloneRepoRequest,
    CloneRepoResponse,
    ConversationListResponse,
    ConversationSummary,
    CreateConversationRequest,
    CreateDirRequest,
    CreateSnapshotRequest,
    FolderGroup,
    GroupedConversationsResponse,
    MessageDetail,
    MessageListResponse,
    MoveConversationRequest,
    MoveFileRequest,
    RegenerateMessageRequest,
    ResolveApprovalRequest,
    SendMessageRequest,
    SnapshotListResponse,
    SnapshotSummary,
    StatusResponse,
    UpdateConversationRequest,
    UploadFileResponse,
    WorkspaceFileEntry,
    WorkspaceFileListResponse,
)
from agentcore.api.sse import sse_response
from agentcore.config import settings
from agentcore.conversation.service import regenerate_chat, stream_chat
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.db.models import Conversation
from agentcore.db.repositories import (
    ConversationRepository,
    FolderRepository,
    MessageRepository,
)
from agentcore.runtime.approvals import default_approval_registry
from agentcore.runtime.events import EventSink
from agentcore.storage import SnapshotNotFound
from agentcore.workspace.files import (
    create_dir,
    delete_file,
    download_file,
    list_files,
    move_file,
    upload_file,
)
from agentcore.workspace.git import CloneError, clone_repo
from agentcore.workspace.locate import workspace_storage_key
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


async def _require_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> None:
    """404 unless the conversation exists and belongs to the user."""
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("Conversation not found")


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


@router.post("", response_model=ConversationSummary, status_code=201)
async def create_conversation(
    body: CreateConversationRequest,
    user: AuthUser,
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    conv = await repo.create(user_id=user.user_id, title=body.title)
    return ConversationSummary.model_validate(conv)


@router.get("", response_model=ConversationListResponse)
async def list_conversations(
    user: AuthUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    repo: ConversationRepository = Depends(get_conversation_repo),
):
    offset = (page - 1) * page_size
    conversations, total = await repo.list_by_user(
        user.user_id, limit=page_size, offset=offset
    )
    return ConversationListResponse(
        data=[ConversationSummary.model_validate(c) for c in conversations],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/grouped", response_model=GroupedConversationsResponse)
async def list_conversations_grouped(
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Folders + their conversations + the ungrouped remainder (sidebar).

    Declared before ``/{conversation_id}`` so "grouped" isn't captured as an id.
    A conversation whose folder is missing/deleted falls back to ungrouped.
    """
    folders = await folder_repo.list_by_user(user.user_id)
    conversations = await conv_repo.list_all_by_user(user.user_id)

    buckets: dict[str, list[ConversationSummary]] = {f.id: [] for f in folders}
    ungrouped: list[ConversationSummary] = []
    for conv in conversations:
        summary = ConversationSummary.model_validate(conv)
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
):
    """Move a conversation into a folder, or out of one (``folder_id=null``).

    A non-null target must be one of the user's own live folders (else 404), so
    a chat can never be filed into someone else's or a deleted folder.
    """
    if body.folder_id is not None:
        folder = await folder_repo.get_by_id(body.folder_id, user_id=user.user_id)
        if not folder:
            raise NotFoundError("Folder not found")
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
):
    """Send a user message and get a streaming AI response via SSE.

    The pipeline runs as a detached task feeding ``sink``; its handle is passed
    to ``sse_response`` so a client disconnect (e.g. the user hits stop) cancels
    it server-side rather than letting it run to completion unobserved.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

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


@router.post("/{conversation_id}/messages/{message_id}/regenerate")
async def regenerate_message(
    conversation_id: str,
    message_id: str,
    body: RegenerateMessageRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Re-run a turn from an existing user message via SSE.

    Serves both "regenerate" (no body content — reuse the stored user text) and
    "edit & resend" (``content`` set — edit the user message first). The target
    ``message_id`` must be a user message; the superseded assistant reply and any
    later turns are dropped before re-running. Like ``send_message``, the pipeline
    runs as a detached task so a client disconnect cancels it server-side.
    """
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)

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
