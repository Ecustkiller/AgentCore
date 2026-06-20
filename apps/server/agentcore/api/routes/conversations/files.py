"""Workspace files (bring files in / take results out: 文件进出·先上传)."""

import mimetypes
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, Depends, Query, Request, Response

from agentcore.api.dependencies import (
    AuthUser,
    get_conversation_repo,
    get_folder_repo,
)
from agentcore.api.schemas import (
    CloneRepoRequest,
    CloneRepoResponse,
    CreateDirRequest,
    FolderSummary,
    MoveFileRequest,
    StatusResponse,
    UploadFileResponse,
    WorkspaceEditDoc,
    WorkspaceFileEntry,
    WorkspaceFileListResponse,
    WorkspaceWriteRequest,
    WorkspaceWriteResult,
)
from agentcore.config import settings
from agentcore.conversation.service import promote_bare_chat_to_folder
from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.db.models import Conversation
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.workspace.files import (
    create_dir,
    delete_file,
    download_file,
    list_files,
    move_file,
    read_file_for_edit,
    upload_file,
    write_file_text,
)
from agentcore.workspace.git import CloneError, clone_repo
from agentcore.workspace.locate import workspace_storage_key
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import (
    AlreadyExists,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
)

from ._helpers import _get_owned_conversation

router = APIRouter(prefix="/conversations", tags=["conversations"])


async def _conv_write_folder(
    conv: Conversation,
    *,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
    user_id: str,
) -> str:
    """Folder id for a *write* to a conversation's workspace, promoting if 裸聊.

    文件夹即工作区: files live in a folder. A filed conversation writes to its folder; a
    裸聊 (no folder) has no workspace, so a creating op (upload / edit / mkdir / clone)
    lazily mints one via the shared ``promote_bare_chat_to_folder`` — the SAME path the
    team's first write takes. So locality is decided by ``conv.local_container_root_id``
    (工作区对称化 D1a), not by whether the panel or the turn wrote first (the bug: the
    panel used to always mint a cloud folder, so a desktop 裸聊's panel-first write hid
    its files in the cloud). No sink — a REST caller has no live stream, so it refetches
    workspaces after its own op instead of receiving ``workspace_promoted``. Returns the
    folder id addressing that workspace.
    """
    if conv.folder_id:
        return conv.folder_id
    result = await promote_bare_chat_to_folder(
        conv_repo=conv_repo,
        folder_repo=folder_repo,
        user_id=user_id,
        conversation_id=conv.id,
        title=conv.title,
        local_container_root_id=conv.local_container_root_id,
    )
    return result.folder_id


@asynccontextmanager
async def _promoted_workspace(
    conv: Conversation,
    *,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
    user_id: str,
) -> AsyncIterator[str]:
    """Resolve (promoting a 裸聊 if needed) then lock a conversation's workspace for a
    *creating* panel op — the shared spine of upload / edit / mkdir / clone.

    Each of those routes used to repeat the same four steps: promote-if-裸聊 →
    ``workspace_storage_key`` → ``workspace_lock`` → run the op. Folding them here keeps
    the locality decision (via ``_conv_write_folder`` → conv.local_container_root_id, 工
    作区对称化 D1a) and the folder lock (决策④: serialize against a running same-folder
    turn) in one place. Yields the folder id the op should target; the caller keeps its
    own op-specific error translation.
    """
    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user_id
    )
    key = workspace_storage_key(
        user_id=user_id, folder_id=folder_id, conversation_id=conv.id
    )
    async with workspace_lock(key):
        yield folder_id


@router.post("/{conversation_id}/workspace/promote", response_model=FolderSummary)
async def promote_workspace(
    conversation_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Lazily promote a 裸聊 into its folder workspace WITHOUT writing a file — the
    server hook for the desktop's *client-side* DeferredWorkspace (工作区对称化 D1a).

    A desktop 裸聊's panel can't write a **local** workspace over the cloud REST file
    routes (those are server-backed; a local write must go through desktop IPC). So
    before its first panel write the client calls this to mint the folder — locality
    decided by ``conv.local_container_root_id`` via the shared ``_conv_write_folder``
    (== the team's first write / the bind endpoint's explicit promote) — then writes
    via IPC into the returned ``local_root_id`` + ``local_subpath``. Idempotent: an
    already-foldered conversation just returns its existing folder. The client applies
    the same cache patches the ``workspace_promoted`` SSE event would (re-group the
    chat + surface the new card), since a REST call carries no live stream.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    folder_id = await _conv_write_folder(
        conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
    )
    folder = await folder_repo.get_by_id(folder_id, user_id=user.user_id)
    if folder is None:
        raise NotFoundError("工作区不存在")
    return FolderSummary.model_validate(folder)


@router.get("/{conversation_id}/workspace/files", response_model=WorkspaceFileListResponse)
async def list_workspace_files(
    conversation_id: str,
    user: AuthUser,
    recursive: bool = Query(False),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """List the files in the conversation's workspace (top level or recursive)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        # 裸聊 has no workspace until promoted into a folder (文件夹即工作区): nothing
        # to list, and a read must never materialize a phantom directory on disk.
        return WorkspaceFileListResponse(data=[], total=0)
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
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Upload (create/overwrite) a workspace file from the raw request body.

    The body is the file bytes (no multipart); ``path`` is the workspace-relative
    target. Bounded by ``workspace_upload_max_bytes`` so one request can't exhaust
    memory. A path that escapes the workspace is rejected (422). Uploading to a 裸聊
    promotes it into a folder workspace first (文件夹即工作区 §懒建).
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)

    max_bytes = settings.workspace_upload_max_bytes
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")
    data = await request.body()
    if len(data) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    try:
        # Promote-if-裸聊 + folder lock (决策④): serialize the write against a running
        # same-folder turn (see _promoted_workspace).
        async with _promoted_workspace(
            conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
        ) as folder_id:
            written = await upload_file(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=path,
                data=data,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    return UploadFileResponse(path=path, size_bytes=written)


@router.get(
    "/{conversation_id}/workspace/edit/{path:path}",
    response_model=WorkspaceEditDoc,
)
async def read_workspace_file_for_edit(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Read a workspace file for in-panel editing (full text + mtime CAS baseline).

    Distinct from the raw-bytes download (preview, truncated): editing needs the whole
    file or a save would drop the tail. 裸聊 has no workspace yet, so 404.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")
    try:
        text, mtime_ms, eol = await read_file_for_edit(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("文件不存在") from e
    except NotUTF8 as e:
        raise ValidationError("文件不是 UTF-8 文本，无法编辑") from e
    return WorkspaceEditDoc(text=text, mtime_ms=mtime_ms, eol=eol)


@router.put(
    "/{conversation_id}/workspace/edit/{path:path}",
    response_model=WorkspaceWriteResult,
)
async def write_workspace_file(
    conversation_id: str,
    path: str,
    body: WorkspaceWriteRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Conditionally write editor text back to a workspace file (mtime CAS).

    The write-time CAS (``baseline_mtime_ms``) makes a save that raced an Agent turn
    return ``conflict`` instead of clobbering it. Writing to a 裸聊 promotes it into a
    folder workspace first (文件夹即工作区 §懒建), like upload.
    """
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)

    max_bytes = settings.workspace_upload_max_bytes
    if len(body.content.encode("utf-8")) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    try:
        # Promote-if-裸聊 + folder lock (决策④): the CAS (mtime check + write) must be
        # atomic against a running same-folder turn, so an Agent write can't slip between
        # check and write (see _promoted_workspace).
        async with _promoted_workspace(
            conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
        ) as folder_id:
            ok, mtime_ms = await write_file_text(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=path,
                content=body.content,
                baseline_mtime_ms=body.baseline_mtime_ms,
                eol=body.eol,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except NotAFile as e:
        raise ValidationError("目标是目录，无法作为文件写入") from e
    return WorkspaceWriteResult(ok=ok, mtime_ms=mtime_ms, conflict=not ok)


@router.get("/{conversation_id}/workspace/files/{path:path}")
async def download_workspace_file(
    conversation_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
):
    """Download a single file from the conversation's workspace."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files yet.
    try:
        data = await download_file(
            user_id=user.user_id,
            folder_id=conv.folder_id,
            conversation_id=conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("文件不存在") from e

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
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files to delete.
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
        raise ValidationError("路径非法：超出工作区范围") from e
    except PathNotFound as e:
        raise NotFoundError("文件不存在") from e
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
    if conv.folder_id is None:
        raise NotFoundError("文件不存在")  # 裸聊 has no workspace files to move.
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
        raise ValidationError("路径非法：超出工作区范围") from e
    except PathNotFound as e:
        raise NotFoundError("文件不存在") from e
    except AlreadyExists as e:
        raise ValidationError("已存在同名文件") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/dirs", response_model=StatusResponse)
async def create_workspace_dir(
    conversation_id: str,
    body: CreateDirRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Create a directory in the conversation's workspace (promotes a 裸聊 first)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    try:
        # Promote-if-裸聊 + folder lock (决策④): serialize against a running same-folder
        # turn (see _promoted_workspace).
        async with _promoted_workspace(
            conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
        ) as folder_id:
            await create_dir(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                path=body.path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except AlreadyExists as e:
        raise ValidationError("已存在同名文件或文件夹") from e
    return StatusResponse()


@router.post("/{conversation_id}/workspace/clone", response_model=CloneRepoResponse)
async def clone_repo_into_workspace(
    conversation_id: str,
    body: CloneRepoRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Clone a public git repository into the conversation's workspace (决策⑤).

    Cloning into a 裸聊 promotes it into a folder workspace first (§懒建)."""
    conv = await _get_owned_conversation(conversation_id, user.user_id, conv_repo)
    try:
        # Promote-if-裸聊 + folder lock (决策④): the clone writes many files; serialize it
        # against a running same-folder turn and other workspace mutations (see
        # _promoted_workspace).
        async with _promoted_workspace(
            conv, conv_repo=conv_repo, folder_repo=folder_repo, user_id=user.user_id
        ) as folder_id:
            dest = await clone_repo(
                user_id=user.user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
                repo_url=body.repo_url,
                dest=body.dest,
            )
    except ValueError as e:
        raise ValidationError(str(e)) from e
    except CloneError as e:
        raise ValidationError(f"克隆失败：{e}") from e
    return CloneRepoResponse(path=dest)
