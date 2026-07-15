"""Folder CRUD routes (项目 = 工作区).

Folders are user-scoped: every route resolves the authenticated user and a
non-owner receives 404 (IDOR-safe). Soft-deleting a folder archives its
conversations in place (keeps ``folder_id``); workspace binding is set at
create and is immutable thereafter.
"""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import AuthUser, get_folder_repo
from agentcore.api.schemas import (
    CreateFolderRequest,
    FolderSummary,
    StatusResponse,
    UpdateFolderRequest,
)
from agentcore.core.errors import NotFoundError
from agentcore.db.repositories import FolderRepository
from agentcore.folders.permanent_delete import permanent_delete_folder

router = APIRouter(prefix="/folders", tags=["folders"])


@router.post("", response_model=FolderSummary, status_code=201)
async def create_folder(
    body: CreateFolderRequest,
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    folder = await repo.create(
        user_id=user.user_id,
        name=body.name,
        local_root_id=body.local_root_id if body.mode == "local" else None,
        local_subpath=body.local_subpath if body.mode == "local" else None,
    )
    return FolderSummary.from_folder(folder)


@router.get("", response_model=list[FolderSummary])
async def list_folders(
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    folders = await repo.list_by_user(user.user_id)
    return [FolderSummary.from_folder(f) for f in folders]


@router.patch("/{folder_id}", response_model=FolderSummary)
async def update_folder(
    folder_id: str,
    body: UpdateFolderRequest,
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    fields = body.model_fields_set
    kwargs: dict = {}
    if "name" in fields:
        kwargs["name"] = body.name
    folder = await repo.update(folder_id, user_id=user.user_id, **kwargs)
    if not folder:
        raise NotFoundError("文件夹不存在")
    return FolderSummary.from_folder(folder)


@router.delete("/{folder_id}", response_model=StatusResponse)
async def delete_folder(
    folder_id: str,
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    deleted = await repo.soft_delete(folder_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("文件夹不存在")
    return StatusResponse()


@router.delete("/{folder_id}/permanent", response_model=StatusResponse)
async def delete_folder_permanent(
    folder_id: str,
    user: AuthUser,
):
    """彻底删除项目：清盘成员对话 + 云端共享工作区/快照，再移除项目行.

    Distinct from ``DELETE /{folder_id}`` (soft-delete + archive members).
    Local-mode OS directories are never touched — only DB + server-side data.
    """
    deleted = await permanent_delete_folder(folder_id=folder_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("文件夹不存在")
    return StatusResponse()
