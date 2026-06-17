"""Admin console routes (平台管理员后台, admin-only).

Every endpoint is gated by the ``AdminUser`` dependency — 401 unauthenticated,
403 for a logged-in non-admin. This server-side role gate (+ the per-account
guards in ``AdminService``) is the *real* authorization boundary; the admin
frontend is just a client (管理员页面设计 决策: 独立 web 控制台, 后端契约先行).

P0 surface = 用户管理: list every account, and patch one account's
role / status / quota. 邀请码 lives under ``/v1/auth/invites`` (already admin-
gated); 全站用量看板 (P1) / 系统状态 (P2) land here later.
"""

from fastapi import APIRouter, Depends, Query

from agentcore.admin import AdminService
from agentcore.api.dependencies import AdminUser, get_admin_service
from agentcore.api.schemas import (
    AdminUpdateUserRequest,
    AdminUserListResponse,
    AdminUserResponse,
)
from agentcore.db.models import User

router = APIRouter(prefix="/admin", tags=["admin"])


def _admin_user_response(user: User) -> AdminUserResponse:
    return AdminUserResponse(
        id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        status=user.status,
        is_unlimited=user.is_unlimited,
        quota_daily_tokens=user.quota_daily_tokens,
        quota_monthly_cost_usd=user.quota_monthly_cost_usd,
        quota_daily_requests=user.quota_daily_requests,
        default_model_mode=user.default_model_mode,
        created_at=user.created_at,
    )


@router.get("/users", response_model=AdminUserListResponse)
async def list_users(
    admin: AdminUser,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str | None = Query(None, max_length=100),
    service: AdminService = Depends(get_admin_service),
) -> AdminUserListResponse:
    """The full account roster (newest-first), paginated. ``q`` substring-filters
    username/display_name. Admin-only directory — enumeration is intended here."""
    users, total = await service.list_users(page=page, page_size=page_size, query=q)
    return AdminUserListResponse(
        data=[_admin_user_response(u) for u in users],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.patch("/users/{user_id}", response_model=AdminUserResponse)
async def update_user(
    user_id: str,
    body: AdminUpdateUserRequest,
    admin: AdminUser,
    service: AdminService = Depends(get_admin_service),
) -> AdminUserResponse:
    """Partially update an account's role / status / quota.

    Only fields *present* in the body are applied (tri-state — see
    ``AdminUpdateUserRequest``): a quota field sent as ``null`` clears the override,
    a value sets it; absent fields are left untouched. Returns the fresh record.
    """
    fields = body.model_fields_set
    # Resolve the quota patch from the set-fields so the route owns the API-shape
    # concern and the repo gets only the dimensions the operator actually changed.
    quota: dict[str, object] = {}
    if "is_unlimited" in fields and body.is_unlimited is not None:
        quota["is_unlimited"] = body.is_unlimited
    if "quota_daily_tokens" in fields:
        quota["daily_tokens"] = body.quota_daily_tokens
    if "quota_monthly_cost_usd" in fields:
        quota["monthly_cost_usd"] = body.quota_monthly_cost_usd
    if "quota_daily_requests" in fields:
        quota["daily_requests"] = body.quota_daily_requests

    updated = await service.update_user(
        actor=admin,
        user_id=user_id,
        role=body.role if "role" in fields else None,
        status=body.status if "status" in fields else None,
        quota=quota or None,
    )
    return _admin_user_response(updated)
