"""Admin 内测群管理员任命 (群级 ``chat_members.role=admin``, 非平台 admin).

- ``GET    /v1/admin/beta-group/moderators``           list
- ``PUT    /v1/admin/beta-group/moderators/{user_id}`` appoint
- ``DELETE /v1/admin/beta-group/moderators/{user_id}`` revoke
"""

from fastapi import APIRouter, Depends

from agentcore.api.dependencies import AdminUser, get_messaging_service
from agentcore.api.schemas import (
    BetaGroupModerator,
    BetaGroupModeratorsResponse,
    StatusResponse,
)
from agentcore.messaging import MessagingService

router = APIRouter()


@router.get("/beta-group/moderators", response_model=BetaGroupModeratorsResponse)
async def list_beta_group_moderators(
    _admin: AdminUser,
    svc: MessagingService = Depends(get_messaging_service),
):
    """List 内测群管理员 (``chat_members.role=admin``)."""
    chat_id, title, users = await svc.list_beta_group_moderators()
    data = [
        BetaGroupModerator(
            id=u.user_id,
            username=u.username,
            display_name=u.display_name,
            is_platform_admin=getattr(u, "role", None) == "admin",
        )
        for u in users
    ]
    return BetaGroupModeratorsResponse(
        chat_id=chat_id, title=title, data=data, total=len(data)
    )


@router.put(
    "/beta-group/moderators/{user_id}",
    response_model=BetaGroupModerator,
)
async def appoint_beta_group_moderator(
    user_id: str,
    admin: AdminUser,
    svc: MessagingService = Depends(get_messaging_service),
):
    """Appoint a user as 内测群管理员 (ensures membership)."""
    user = await svc.set_beta_group_moderator(user_id=user_id, actor_id=admin.user_id)
    return BetaGroupModerator(
        id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        is_platform_admin=getattr(user, "role", None) == "admin",
    )


@router.delete(
    "/beta-group/moderators/{user_id}",
    response_model=StatusResponse,
)
async def revoke_beta_group_moderator(
    user_id: str,
    admin: AdminUser,
    svc: MessagingService = Depends(get_messaging_service),
):
    """Revoke 内测群管理员 (role → member; stays in group)."""
    await svc.clear_beta_group_moderator(user_id=user_id, actor_id=admin.user_id)
    return StatusResponse()
