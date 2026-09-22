"""User default boundary — seeds new-conversation permission only."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from agentcore.api.dependencies import AuthUser, get_user_repo
from agentcore.core.types import WorkspaceBoundary
from agentcore.db.repositories import UserRepository

router = APIRouter(prefix="/users/me/autonomy", tags=["autonomy"])


class AutonomyView(BaseModel):
    policy: WorkspaceBoundary = WorkspaceBoundary.FOLDER


class AutonomyUpdate(BaseModel):
    policy: WorkspaceBoundary = Field(
        ...,
        description="New-session default boundary: read | folder | computer",
    )


@router.get("", response_model=AutonomyView)
async def get_autonomy(
    user: AuthUser,
    users: UserRepository = Depends(get_user_repo),
) -> AutonomyView:
    row = await users.get_by_id(user.user_id)
    raw = (row.autonomy_policy if row else None) or WorkspaceBoundary.FOLDER.value
    try:
        return AutonomyView(policy=WorkspaceBoundary(raw))
    except ValueError:
        return AutonomyView(policy=WorkspaceBoundary.FOLDER)


@router.put("", response_model=AutonomyView)
async def put_autonomy(
    body: AutonomyUpdate,
    user: AuthUser,
    users: UserRepository = Depends(get_user_repo),
) -> AutonomyView:
    await users.set_autonomy_policy(user.user_id, body.policy.value)
    return AutonomyView(policy=body.policy)
