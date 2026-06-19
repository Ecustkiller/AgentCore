"""Authentication routes: register, login, refresh, logout, me (+ bearer-token twins).

The cookie flow delivers tokens as httpOnly cookies so the browser/Electron client
never handles them in JS (XSS-resistant); the refresh cookie is path-scoped to the
auth endpoints and the access cookie rides every API call. The ``/token*`` endpoints
are the body-returning twins for non-cookie clients (mobile web / Capacitor shell,
M2) whose origin can't rely on SameSite cookies — they send ``Authorization: Bearer``
instead (认证与会话.md §十; resolution in api/dependencies.py).
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Response

from agentcore.api.account_cleanup import cleanup_account_resources
from agentcore.api.dependencies import (
    ACCESS_TOKEN_COOKIE,
    AdminUser,
    AuthUser,
    get_asset_storage,
    get_auth_service,
    get_conversation_repo,
    get_conversation_share_repo,
    get_messaging_service,
    get_user_llm_key_repo,
)
from agentcore.api.schemas import (
    ChangePasswordRequest,
    CreateInviteRequest,
    DeleteAccountRequest,
    InviteListResponse,
    InviteResponse,
    LoginRequest,
    RegisterRequest,
    StatusResponse,
    TokenRefreshRequest,
    TokenResponse,
    TokenRevokeRequest,
    UpdateProfileRequest,
    UserResponse,
)
from agentcore.auth import AuthService, TokenPair
from agentcore.config import settings
from agentcore.core.errors import AuthenticationError
from agentcore.core.logging import get_logger
from agentcore.db.models import Invite, User
from agentcore.db.repositories import (
    ConversationRepository,
    ConversationShareRepository,
    UserLlmKeyRepository,
)
from agentcore.messaging import MessagingService
from agentcore.storage.assets import AssetStorage

logger = get_logger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_TOKEN_COOKIE = "refresh_token"
# Refresh cookie only needs to travel to the refresh/logout endpoints.
_REFRESH_COOKIE_PATH = "/v1/auth"

RefreshCookie = Annotated[str | None, Cookie(alias=REFRESH_TOKEN_COOKIE)]


def _user_response(user: User) -> UserResponse:
    return UserResponse.from_user(user)


def _invite_status(invite: Invite, now: datetime) -> str:
    # Terminal first: a consumed code stays "used" even if later revoked/expired.
    if invite.used_at is not None:
        return "used"
    if invite.revoked_at is not None:
        return "revoked"
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
        revoked_at=invite.revoked_at,
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
    messaging: MessagingService = Depends(get_messaging_service),
):
    user = await service.register(
        username=body.username,
        password=body.password,
        invite_code=body.invite_code,
        display_name=body.display_name,
        email=body.email,
    )
    # Enroll the new account into every auto-join chat (the 内测全员群). Best-effort
    # so a messaging hiccup never blocks account creation — a missed enrollment can
    # be backfilled later; auto-join fires only here (not on login) so leaving sticks.
    try:
        await messaging.join_auto_join_chats(user_id=user.user_id)
    except Exception:
        logger.warning("chat.auto_join_failed", user=user.user_id, exc_info=True)
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


# --- Bearer-token flow (mobile web / Capacitor shell, M2) ---
# Body-returning twins of the cookie login/refresh/logout above, for clients whose
# origin (capacitor:// / a new web origin) can't rely on SameSite cookies (认证与会话.md
# §十). Same AuthService + token machinery; the client stores the returned tokens and
# sends `Authorization: Bearer <access>` on every call (resolved in api/dependencies.py).


def _token_response(tokens: TokenPair, *, user: User | None = None) -> TokenResponse:
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=settings.jwt_access_token_expire_minutes * 60,
        user=_user_response(user) if user is not None else None,
    )


@router.post("/token", response_model=TokenResponse)
async def token_login(
    body: LoginRequest,
    service: AuthService = Depends(get_auth_service),
):
    """Bearer-token login: same credential check as cookie ``/login`` but returns the
    access + refresh tokens in the JSON body (plus the user — identity in one call)."""
    user, tokens = await service.login(username=body.username, password=body.password)
    return _token_response(tokens, user=user)


@router.post("/token/refresh", response_model=TokenResponse)
async def token_refresh(
    body: TokenRefreshRequest,
    service: AuthService = Depends(get_auth_service),
):
    """Rotate a bearer client's token pair (refresh token carried in the body). Reuse /
    expiry detection is the same family-revoking logic as cookie refresh."""
    tokens = await service.refresh(refresh_token=body.refresh_token)
    return _token_response(tokens)


@router.post("/token/revoke", response_model=StatusResponse)
async def token_revoke(
    body: TokenRevokeRequest,
    service: AuthService = Depends(get_auth_service),
):
    """Bearer-client logout: revoke the refresh token's whole family. Idempotent — an
    unknown / already-revoked token still returns ok (never reveals token validity)."""
    await service.logout(refresh_token=body.refresh_token)
    return StatusResponse()


@router.get("/me", response_model=UserResponse)
async def me(user: AuthUser):
    return _user_response(user)


@router.patch("/me", response_model=UserResponse)
async def update_me(
    body: UpdateProfileRequest,
    user: AuthUser,
    service: AuthService = Depends(get_auth_service),
):
    """Edit the signed-in user's profile (个人资料编辑). PATCH semantics: only the fields
    present in the body change — an explicit ``null`` email clears it, an omitted field
    is left untouched (distinguished via ``model_fields_set``)."""
    fields = body.model_dump(include=body.model_fields_set)
    updated = await service.update_profile(user_id=user.user_id, **fields)
    return _user_response(updated)


@router.post("/change-password", response_model=StatusResponse)
async def change_password(
    body: ChangePasswordRequest,
    user: AuthUser,
    response: Response,
    service: AuthService = Depends(get_auth_service),
):
    """Change the signed-in user's password (修改密码). All other devices are logged out
    (their refresh families are revoked); this session is handed fresh cookies so the
    active device stays signed in."""
    tokens = await service.change_password(
        user_id=user.user_id,
        current_password=body.current_password,
        new_password=body.new_password,
    )
    _set_auth_cookies(response, tokens)
    return StatusResponse()


@router.delete("/me", response_model=StatusResponse)
async def delete_account(
    body: DeleteAccountRequest,
    user: AuthUser,
    response: Response,
    service: AuthService = Depends(get_auth_service),
    conversations: ConversationRepository = Depends(get_conversation_repo),
    shares: ConversationShareRepository = Depends(get_conversation_share_repo),
    llm_keys: UserLlmKeyRepository = Depends(get_user_llm_key_repo),
    assets: AssetStorage = Depends(get_asset_storage),
):
    """Self-service account deletion (注销账户). Verifies the password, then soft-deletes
    + anonymizes the account and revokes all sessions. Cross-domain cleanup lives here
    (outside the auth domain): soft-delete the user's conversations so the retention
    sweeper reclaims their workspaces, revoke every public share link so no shared
    snapshot outlives the account, drop the BYOK key so no ciphertext outlives the
    account, and remove the avatar object. Finally clear this device's cookies."""
    avatar_key = user.avatar_key  # captured before soft_delete nulls it
    await service.delete_account(user_id=user.user_id, password=body.password)
    await cleanup_account_resources(
        user.user_id,
        avatar_key=avatar_key,
        conversations=conversations,
        shares=shares,
        llm_keys=llm_keys,
        assets=assets,
    )
    _clear_auth_cookies(response)
    return StatusResponse()


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


@router.post("/invites/{invite_id}/revoke", response_model=InviteResponse)
async def revoke_invite(
    invite_id: str,
    admin: AdminUser,
    service: AuthService = Depends(get_auth_service),
):
    """Retire an unused invite (邀请码撤销). 404 unknown id; 422 if already used/revoked.
    Returns the now-revoked invite so the client can update the row in place."""
    invite = await service.revoke_invite(invite_id=invite_id)
    return _invite_response(invite, datetime.now(UTC))
