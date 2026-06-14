"""Authentication routes: register, login, refresh, logout, me.

Tokens are delivered as httpOnly cookies so the browser/Electron client never
handles them in JS (XSS-resistant). The refresh cookie is path-scoped to the
auth endpoints; the access cookie is sent on every API call.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Response

from agentcore.api.dependencies import (
    ACCESS_TOKEN_COOKIE,
    AdminUser,
    AuthUser,
    get_auth_service,
)
from agentcore.api.schemas import (
    CreateInviteRequest,
    InviteListResponse,
    InviteResponse,
    LoginRequest,
    RegisterRequest,
    StatusResponse,
    UserResponse,
)
from agentcore.auth import AuthService, TokenPair
from agentcore.config import settings
from agentcore.core.errors import AuthenticationError
from agentcore.db.models import Invite, User

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_TOKEN_COOKIE = "refresh_token"
# Refresh cookie only needs to travel to the refresh/logout endpoints.
_REFRESH_COOKIE_PATH = "/v1/auth"

RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_TOKEN_COOKIE)]


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.user_id,
        username=user.username,
        display_name=user.display_name,
        email=user.email,
        role=user.role,
        created_at=user.created_at,
    )


def _invite_status(invite: Invite, now: datetime) -> str:
    if invite.used_at is not None:
        return "used"
    if invite.expires_at is not None and invite.expires_at <= now:
        return "expired"
    return "active"


def _invite_response(invite: Invite, now: datetime) -> InviteResponse:
    return InviteResponse(
        id=invite.id,
        code=invite.code,
        status=_invite_status(invite, now),
        created_by=invite.created_by,
        used_by=invite.used_by,
        created_at=invite.created_at,
        expires_at=invite.expires_at,
        used_at=invite.used_at,
    )


def _set_auth_cookies(response: Response, tokens: TokenPair) -> None:
    response.set_cookie(
        key=ACCESS_TOKEN_COOKIE,
        value=tokens.access_token,
        max_age=settings.jwt_access_token_expire_minutes * 60,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )
    response.set_cookie(
        key=REFRESH_TOKEN_COOKIE,
        value=tokens.refresh_token,
        max_age=settings.jwt_refresh_token_expire_days * 86400,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path=_REFRESH_COOKIE_PATH,
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(ACCESS_TOKEN_COOKIE, path="/")
    response.delete_cookie(REFRESH_TOKEN_COOKIE, path=_REFRESH_COOKIE_PATH)


@router.post("/register", response_model=UserResponse, status_code=201)
async def register(
    body: RegisterRequest,
    service: AuthService = Depends(get_auth_service),
):
    user = await service.register(
        username=body.username,
        password=body.password,
        invite_code=body.invite_code,
        display_name=body.display_name,
        email=body.email,
    )
    return _user_response(user)


@router.post("/login", response_model=UserResponse)
async def login(
    body: LoginRequest,
    response: Response,
    service: AuthService = Depends(get_auth_service),
):
    user, tokens = await service.login(username=body.username, password=body.password)
    _set_auth_cookies(response, tokens)
    return _user_response(user)


@router.post("/refresh", response_model=StatusResponse)
async def refresh(
    response: Response,
    refresh_token: RefreshCookie = None,
    service: AuthService = Depends(get_auth_service),
):
    if not refresh_token:
        raise AuthenticationError("Missing refresh token")
    try:
        tokens = await service.refresh(refresh_token=refresh_token)
    except AuthenticationError:
        # Token invalid/expired/reused: clear cookies so the client logs in again.
        _clear_auth_cookies(response)
        raise
    _set_auth_cookies(response, tokens)
    return StatusResponse()


@router.post("/logout", response_model=StatusResponse)
async def logout(
    response: Response,
    refresh_token: RefreshCookie = None,
    service: AuthService = Depends(get_auth_service),
):
    if refresh_token:
        await service.logout(refresh_token=refresh_token)
    _clear_auth_cookies(response)
    return StatusResponse()


@router.get("/me", response_model=UserResponse)
async def me(user: AuthUser):
    return _user_response(user)


@router.post("/invites", response_model=InviteResponse, status_code=201)
async def create_invite(
    admin: AdminUser,
    body: CreateInviteRequest | None = None,
    service: AuthService = Depends(get_auth_service),
):
    invite = await service.create_invite(
        created_by=admin.user_id,
        expires_in_days=body.expires_in_days if body else None,
    )
    return _invite_response(invite, datetime.now(UTC))


@router.get("/invites", response_model=InviteListResponse)
async def list_invites(
    admin: AdminUser,
    service: AuthService = Depends(get_auth_service),
):
    now = datetime.now(UTC)
    invites = await service.list_invites()
    return InviteListResponse(
        data=[_invite_response(i, now) for i in invites],
        total=len(invites),
    )
