"""Folder CRUD routes (sidebar conversation grouping).

Folders are user-scoped: every route resolves the authenticated user and a
non-owner receives 404 (IDOR-safe). Deleting a folder keeps its conversations —
their membership just falls back to ungrouped (see the repository).
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
        local_dir=body.local_dir,
        local_root_id=body.local_root_id,
    )
    return FolderSummary.model_validate(folder)


@router.get("", response_model=list[FolderSummary])
async def list_folders(
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    folders = await repo.list_by_user(user.user_id)
    return [FolderSummary.model_validate(f) for f in folders]


@router.patch("/{folder_id}", response_model=FolderSummary)
async def update_folder(
    folder_id: str,
    body: UpdateFolderRequest,
    user: AuthUser,
    repo: FolderRepository = Depends(get_folder_repo),
):
    # Pass only the fields the client actually sent, so an omitted ``local_dir``
    # is left untouched while an explicit null clears the binding.
    fields = body.model_fields_set
    kwargs: dict = {}
    if "name" in fields:
        kwargs["name"] = body.name
    if "local_dir" in fields:
        kwargs["local_dir"] = body.local_dir
    folder = await repo.update(folder_id, user_id=user.user_id, **kwargs)
    if not folder:
        raise NotFoundError("文件夹不存在")
    return FolderSummary.model_validate(folder)


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
    """彻底删除项目：立即清除文件夹、其下全部对话及云端工作区文件。

    Distinct from ``DELETE /{folder_id}`` (soft-delete container with retention).
    Local-bound projects: server metadata + cloud copies only — files on the
    user's machine are not deleted.
    """
    deleted = await permanent_delete_folder(folder_id=folder_id, user_id=user.user_id)
    if not deleted:
        raise NotFoundError("文件夹不存在")
    return StatusResponse()
