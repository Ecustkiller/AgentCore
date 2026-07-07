"""Model quality-mode (质量档) routes — **hibernated** (Phase 1c).

Routes are retained for backward-compatible OpenAPI paths; reads return empty catalogs
and writes respond with 410 Gone. Per-conversation ``model_mode`` is accept-but-ignore
on conversation routes.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from agentcore.api.dependencies import AuthUser, get_model_mode_repo, get_user_repo
from agentcore.api.schemas import (
    CreateModelModeRequest,
    ModelModeCatalog,
    ModelModesResponse,
    ModelModeSummary,
    SetDefaultModeRequest,
    StatusResponse,
    UpdateModelModeRequest,
)
from agentcore.db.repositories import ModelModeRepository, UserRepository

router = APIRouter(prefix="/model-modes", tags=["model-modes"])

_GONE_DETAIL = "质量档已停用；请在设置中配置模型。"


def _gone() -> None:
    raise HTTPException(status_code=status.HTTP_410_GONE, detail=_GONE_DETAIL)


@router.get("", response_model=ModelModesResponse)
async def list_model_modes(user: AuthUser):
    """Empty catalog — quality modes are no longer supported."""
    return ModelModesResponse(presets=[], custom=[], default_mode="")


@router.get("/catalog", response_model=ModelModeCatalog)
async def model_mode_catalog(user: AuthUser):
    """Empty option space — quality modes are no longer supported."""
    return ModelModeCatalog(roles=[], models=[])


@router.post("", response_model=ModelModeSummary, status_code=201)
async def create_model_mode(
    body: CreateModelModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    _gone()


@router.patch("/{mode_id}", response_model=ModelModeSummary)
async def update_model_mode(
    mode_id: str,
    body: UpdateModelModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    _gone()


@router.delete("/{mode_id}", response_model=StatusResponse)
async def delete_model_mode(
    mode_id: str,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
):
    _gone()


@router.put("/default", response_model=StatusResponse)
async def set_default_model_mode(
    body: SetDefaultModeRequest,
    user: AuthUser,
    repo: ModelModeRepository = Depends(get_model_mode_repo),
    user_repo: UserRepository = Depends(get_user_repo),
):
    _gone()
