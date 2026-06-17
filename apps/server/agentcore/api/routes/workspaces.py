"""Workspace as a first-class, addressable resource (文件中枢统一 Step 1).

文件夹即工作区: a workspace **is** a folder, addressed by its own id
(``folder:<id>``, see ``workspace.locate``) rather than only "through a
conversation". This router is that surface: enumerate a user's workspaces, then
read/CRUD/snapshot any one by id.

Addressing is the only thing new here — the actual file/snapshot/clone logic stays
single-sourced in the ``workspace.*`` service layer that the per-conversation
routes also call (those remain the thin per-conversation alias). Every route is
owner-scoped: the ``ident`` in a ws id is resolved against the user's own folders,
so a non-owner (or a bad id) gets 404 — never another user's data.

Cloud vs local (§五 边界): a **local** workspace's files live on the user's
machine and are reached over desktop IPC, not here; its server-side dir is not the
truth. So file/dir/move/clone and snapshot create/restore reject local ids with
409 — the hub routes those to the desktop. Read-only snapshot list/download stay
open (snapshots are object-store backed, keyed by ws, even for local).
"""

from __future__ import annotations

import mimetypes
from dataclasses import dataclass
from typing import Literal

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
    CreateSnapshotRequest,
    MoveFileRequest,
    SnapshotListResponse,
    SnapshotSummary,
    StatusResponse,
    UploadFileResponse,
    WorkspaceEditDoc,
    WorkspaceFileEntry,
    WorkspaceFileIndexResponse,
    WorkspaceFileListResponse,
    WorkspaceListResponse,
    WorkspaceSummary,
    WorkspaceWriteRequest,
    WorkspaceWriteResult,
)
from agentcore.config import settings
from agentcore.core.errors import ConflictError, NotFoundError, ValidationError
from agentcore.db.repositories import ConversationRepository, FolderRepository
from agentcore.storage import SnapshotNotFound
from agentcore.workspace.files import (
    create_dir,
    delete_file,
    download_file,
    list_file_index,
    list_files,
    move_file,
    read_file_for_edit,
    upload_file,
    write_file_text,
)
from agentcore.workspace.git import CloneError, clone_repo
from agentcore.workspace.locate import (
    parse_workspace_id,
    workspace_has_entries,
    workspace_storage_key,
)
from agentcore.workspace.locks import workspace_lock
from agentcore.workspace.protocol import (
    AlreadyExists,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
)
from agentcore.workspace.snapshots import (
    create_snapshot,
    list_snapshots,
    read_snapshot,
    restore_snapshot,
)

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


@dataclass(frozen=True)
class _WsTarget:
    """A resolved, owned workspace — the (folder_id, conversation_id) the service
    layer keys on, plus the location that gates which ops are allowed here."""

    ws_id: str
    folder_id: str | None
    conversation_id: str  # "" for a folder workspace (its path ignores it)
    name: str
    location: Literal["cloud", "local"]
    root_id: str | None


async def _resolve_owned_workspace(
    ws_id: str,
    user_id: str,
    conv_repo: ConversationRepository,
    folder_repo: FolderRepository,
) -> _WsTarget:
    """Resolve a ws id to an owned folder workspace, or 404.

    文件夹即工作区: a workspace **is** a folder (``folder:<id>``), so only that kind
    resolves. A conversation no longer owns a standalone space — a 裸聊 has none until
    it is promoted into a folder — so a ``conv:<id>`` (or any non-folder id) is 404.
    ``conv_repo`` is kept in the signature for call-site symmetry across the routes.
    """
    try:
        parsed = parse_workspace_id(ws_id)
    except ValueError as e:
        raise NotFoundError("工作区不存在") from e

    if parsed.kind != "folder":
        raise NotFoundError("工作区不存在")
    folder = await folder_repo.get_by_id(parsed.ident, user_id=user_id)
    if not folder:
        raise NotFoundError("工作区不存在")
    return _WsTarget(
        ws_id=ws_id,
        folder_id=folder.id,
        conversation_id="",
        name=folder.name,
        location="local" if folder.local_root_id else "cloud",
        root_id=folder.local_root_id,
    )


def _require_cloud(target: _WsTarget) -> None:
    """Reject ops that only make sense server-side on a local workspace (§五).

    A local workspace's files live on the user's machine; the hub reaches them
    over desktop IPC, so writing/snapshotting the server-side mirror here would
    silently diverge from the truth.
    """
    if target.location == "local":
        raise ConflictError("本地工作区的文件请在桌面端访问")


def _storage_key(user_id: str, target: _WsTarget) -> str:
    return workspace_storage_key(
        user_id=user_id,
        folder_id=target.folder_id,
        conversation_id=target.conversation_id,
    )


@router.get("", response_model=WorkspaceListResponse)
async def list_workspaces(
    user: AuthUser,
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Enumerate the user's workspaces (文件夹即工作区: a workspace **is** a folder).

    Every folder is a project, always listed — local ones unconditionally (the
    server can't see their files, and a binding is explicit intent, not noise),
    cloud ones carrying a ``has_files`` flag. Conversations are not workspaces: a
    裸聊 has no space until it is promoted into a folder, after which it appears here
    as that folder.
    """
    folders = await folder_repo.list_by_user(user.user_id)
    items: list[WorkspaceSummary] = []
    for f in folders:
        local = f.local_root_id is not None
        items.append(
            WorkspaceSummary(
                ws_id=f"folder:{f.id}",
                name=f.name,
                location="local" if local else "cloud",
                root_id=f.local_root_id,
                has_files=True
                if local
                else workspace_has_entries(
                    user_id=user.user_id, folder_id=f.id, conversation_id=""
                ),
            )
        )
    return WorkspaceListResponse(data=items, total=len(items))


# --- Workspace files (cloud workspaces; local ones are reached over IPC) ---


@router.get("/{ws_id}/files", response_model=WorkspaceFileListResponse)
async def list_workspace_files(
    ws_id: str,
    user: AuthUser,
    recursive: bool = Query(False),
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """List files in a cloud workspace (top level or recursive)."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    entries = await list_files(
        user_id=user.user_id,
        folder_id=target.folder_id,
        conversation_id=target.conversation_id,
        recursive=recursive,
    )
    return WorkspaceFileListResponse(
        data=[WorkspaceFileEntry.model_validate(e) for e in entries],
        total=len(entries),
    )


@router.get("/{ws_id}/file-index", response_model=WorkspaceFileIndexResponse)
async def list_workspace_file_index(
    ws_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Flat file-path list for @ mentions over a cloud workspace (文件中枢统一 F4).

    Files only, ignore-pruned, capped — so cloud workspace files feed the same @
    index local roots already do. Local workspaces are reached over desktop IPC
    (their files aren't here), so they are refused with 409 like other file ops.
    """
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    paths, truncated = await list_file_index(
        user_id=user.user_id,
        folder_id=target.folder_id,
        conversation_id=target.conversation_id,
    )
    return WorkspaceFileIndexResponse(data=paths, total=len(paths), truncated=truncated)


@router.put("/{ws_id}/files/{path:path}", response_model=UploadFileResponse)
async def upload_workspace_file(
    ws_id: str,
    path: str,
    request: Request,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Upload (create/overwrite) a workspace file from the raw request body.

    Body is the file bytes (no multipart); ``path`` is the workspace-relative
    target. Bounded by ``workspace_upload_max_bytes``; a path escaping the
    workspace is rejected (422).
    """
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)

    max_bytes = settings.workspace_upload_max_bytes
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")
    data = await request.body()
    if len(data) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    try:
        # Folder lock (决策④): serialize the write against a running same-space turn.
        async with workspace_lock(_storage_key(user.user_id, target)):
            written = await upload_file(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
                path=path,
                data=data,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    return UploadFileResponse(path=path, size_bytes=written)


@router.get("/{ws_id}/edit/{path:path}", response_model=WorkspaceEditDoc)
async def read_workspace_file_for_edit(
    ws_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Read a cloud workspace file for in-panel editing (full text + mtime baseline).

    The editable counterpart of the truncated preview download — a save needs the
    whole file. Local ids are reached over desktop IPC, so they 409 like other ops.
    """
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        text, mtime_ms, eol = await read_file_for_edit(
            user_id=user.user_id,
            folder_id=target.folder_id,
            conversation_id=target.conversation_id,
            path=path,
        )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except (PathNotFound, NotAFile) as e:
        raise NotFoundError("文件不存在") from e
    except NotUTF8 as e:
        raise ValidationError("文件不是 UTF-8 文本，无法编辑") from e
    return WorkspaceEditDoc(text=text, mtime_ms=mtime_ms, eol=eol)


@router.put("/{ws_id}/edit/{path:path}", response_model=WorkspaceWriteResult)
async def write_workspace_file_text(
    ws_id: str,
    path: str,
    body: WorkspaceWriteRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Conditionally write editor text back to a cloud workspace file (mtime CAS).

    ``baseline_mtime_ms`` makes a save that raced an Agent turn return ``conflict``
    instead of clobbering it (云端硬化 §九). Local ids 409 (desktop owns the bytes).
    """
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)

    max_bytes = settings.workspace_upload_max_bytes
    if len(body.content.encode("utf-8")) > max_bytes:
        raise ValidationError(f"文件超出 {max_bytes} 字节的上传上限")

    try:
        # Folder lock (决策④): the CAS (mtime check + write) is atomic against a running
        # same-space turn, so an Agent write can't slip between check and write.
        async with workspace_lock(_storage_key(user.user_id, target)):
            ok, mtime_ms = await write_file_text(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
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


@router.get("/{ws_id}/files/{path:path}")
async def download_workspace_file(
    ws_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Download a single file from a cloud workspace."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        data = await download_file(
            user_id=user.user_id,
            folder_id=target.folder_id,
            conversation_id=target.conversation_id,
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


@router.delete("/{ws_id}/files/{path:path}", response_model=StatusResponse)
async def delete_workspace_file(
    ws_id: str,
    path: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Delete a file or directory from a cloud workspace."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        async with workspace_lock(_storage_key(user.user_id, target)):
            await delete_file(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
                path=path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except PathNotFound as e:
        raise NotFoundError("文件不存在") from e
    return StatusResponse()


@router.post("/{ws_id}/move", response_model=StatusResponse)
async def move_workspace_file(
    ws_id: str,
    body: MoveFileRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Move/rename a file or directory within a cloud workspace."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        async with workspace_lock(_storage_key(user.user_id, target)):
            await move_file(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
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


@router.post("/{ws_id}/dirs", response_model=StatusResponse)
async def create_workspace_dir(
    ws_id: str,
    body: CreateDirRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Create a directory in a cloud workspace."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        async with workspace_lock(_storage_key(user.user_id, target)):
            await create_dir(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
                path=body.path,
            )
    except OutsideWorkspace as e:
        raise ValidationError("路径非法：超出工作区范围") from e
    except AlreadyExists as e:
        raise ValidationError("已存在同名文件或文件夹") from e
    return StatusResponse()


@router.post("/{ws_id}/clone", response_model=CloneRepoResponse)
async def clone_repo_into_workspace(
    ws_id: str,
    body: CloneRepoRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Clone a public git repository into a cloud workspace (决策⑤)."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        async with workspace_lock(_storage_key(user.user_id, target)):
            dest = await clone_repo(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
                repo_url=body.repo_url,
                dest=body.dest,
            )
    except ValueError as e:
        raise ValidationError(str(e)) from e
    except CloneError as e:
        raise ValidationError(f"克隆失败：{e}") from e
    return CloneRepoResponse(path=dest)


# --- Workspace snapshots (axis-3: backup / kept versions / download) ---


@router.get("/{ws_id}/snapshots", response_model=SnapshotListResponse)
async def list_workspace_snapshots(
    ws_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """List a workspace's snapshots (newest first). Allowed for local too —
    snapshots are object-store backed and keyed by ws (§五)."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    refs = await list_snapshots(
        user_id=user.user_id,
        folder_id=target.folder_id,
        conversation_id=target.conversation_id,
    )
    return SnapshotListResponse(
        data=[SnapshotSummary.model_validate(r) for r in refs],
        total=len(refs),
    )


@router.post("/{ws_id}/snapshots", response_model=SnapshotSummary, status_code=201)
async def create_workspace_snapshot(
    ws_id: str,
    body: CreateSnapshotRequest,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Take a manual snapshot of a cloud workspace (a ``label`` keeps it as a
    version). Local workspaces snapshot via the desktop archive channel, not
    here (§五), so they are rejected with 409."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    async with workspace_lock(_storage_key(user.user_id, target)):
        ref = await create_snapshot(
            user_id=user.user_id,
            folder_id=target.folder_id,
            conversation_id=target.conversation_id,
            label=body.label,
        )
    return SnapshotSummary.model_validate(ref)


@router.post(
    "/{ws_id}/snapshots/{snapshot_id}/restore", response_model=StatusResponse
)
async def restore_workspace_snapshot(
    ws_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Restore a cloud workspace to a snapshot (overwrites current files).

    Refused (409) for local workspaces: it would rewrite the unused server-side
    mirror, not the user's machine."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    _require_cloud(target)
    try:
        async with workspace_lock(_storage_key(user.user_id, target)):
            await restore_snapshot(
                user_id=user.user_id,
                folder_id=target.folder_id,
                conversation_id=target.conversation_id,
                snapshot_id=snapshot_id,
            )
    except SnapshotNotFound as e:
        raise NotFoundError("快照不存在") from e
    return StatusResponse()


@router.get("/{ws_id}/snapshots/{snapshot_id}/download")
async def download_workspace_snapshot(
    ws_id: str,
    snapshot_id: str,
    user: AuthUser,
    conv_repo: ConversationRepository = Depends(get_conversation_repo),
    folder_repo: FolderRepository = Depends(get_folder_repo),
):
    """Download a snapshot archive (zip). Allowed for local too (read-only)."""
    target = await _resolve_owned_workspace(ws_id, user.user_id, conv_repo, folder_repo)
    try:
        data = await read_snapshot(
            user_id=user.user_id,
            folder_id=target.folder_id,
            conversation_id=target.conversation_id,
            snapshot_id=snapshot_id,
        )
    except SnapshotNotFound as e:
        raise NotFoundError("快照不存在") from e
    filename = f"workspace-{snapshot_id}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
