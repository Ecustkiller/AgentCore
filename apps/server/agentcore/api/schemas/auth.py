"""Auth, profile, and invite request/response schemas."""

from datetime import datetime
from typing import TYPE_CHECKING, Literal

from pydantic import BaseModel, Field

from ._helpers import _avatar_url

if TYPE_CHECKING:
    from agentcore.db.models import User


class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=100)
    password: str = Field(..., min_length=8, max_length=256)
    invite_code: str = Field(..., min_length=1, max_length=64)
    display_name: str | None = Field(None, max_length=200)
    # Plain string for now (email is a reserved/optional profile field); upgrade
    # to validated EmailStr if/when email-validator is added as a dependency.
    email: str | None = Field(None, max_length=255)


class LoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=100)
    password: str = Field(..., min_length=1, max_length=256)


class ChangePasswordRequest(BaseModel):
    """Self-service password change (修改密码): the current password proves intent,
    the new one is validated server-side (same ≥8 policy as registration)."""

    current_password: str = Field(..., min_length=1, max_length=256)
    new_password: str = Field(..., min_length=8, max_length=256)


class UpdateProfileRequest(BaseModel):
    """Patch the signed-in user's profile (个人资料编辑). Both fields optional — only
    those present are changed; an explicit ``null`` email clears it. ``display_name``
    must be non-empty when present (enforced in the service)."""

    display_name: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=255)


class DeleteAccountRequest(BaseModel):
    """Self-service account deletion (注销账户): the password re-confirms a
    destructive, irreversible action before the account is soft-deleted + anonymized."""

    password: str = Field(..., min_length=1, max_length=256)


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str
    email: str | None
    role: str
    created_at: datetime
    # The user's default 质量档 (llm/modes.py): a preset name or custom mode id;
    # None = inherit the operator default. Surfaced so the client knows the default
    # at login without a second call.
    default_model_mode: str | None = None
    # Served avatar URL (头像) derived from the stored object key, e.g.
    # ``/v1/users/<id>/avatar?v=<hash>``; None = no avatar. A relative path on
    # purpose — the backend is agnostic of its public origin, so the client prefixes
    # its API base. The ``?v=`` is a content hash, so the cached <img> refreshes on
    # change. → see api/routes/users.py for the (public) serving endpoint.
    avatar_url: str | None = None
    # True when an admin reset handed a one-off temp password — the client should
    # force a self-service password change before normal use.
    password_must_change: bool = False

    @classmethod
    def from_user(cls, user: "User", *, password_must_change: bool = False) -> "UserResponse":
        """Build the API view of a user row (the single source for this mapping)."""
        return cls(
            id=user.user_id,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            role=user.role,
            created_at=user.created_at,
            default_model_mode=user.default_model_mode,
            avatar_url=_avatar_url(user.user_id, user.avatar_key),
            password_must_change=password_must_change,
        )


class TokenResponse(BaseModel):
    """Bearer-token bundle for non-cookie clients (mobile web / Capacitor shell, M2).

    The cookie login (``/v1/auth/login``) keeps tokens in httpOnly cookies; this is
    its body-returning twin for clients whose origin (``capacitor://`` / a new web
    origin) can't rely on SameSite cookies (认证与会话.md §十). ``expires_in`` is the
    access token's lifetime in seconds so the client refreshes before it lapses;
    ``user`` rides the login response (identity in one round trip) and is omitted on
    refresh.
    """

    access_token: str
    refresh_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserResponse | None = None


class TokenRefreshRequest(BaseModel):
    """Rotate a bearer client's token pair (refresh token in the body, not a cookie)."""

    refresh_token: str = Field(..., min_length=1, max_length=512)


class TokenRevokeRequest(BaseModel):
    """Bearer-client logout: revoke the presented refresh token's whole family."""

    refresh_token: str = Field(..., min_length=1, max_length=512)


class CreateInviteRequest(BaseModel):
    # None = never expires; otherwise the code is valid for this many days.
    expires_in_days: int | None = Field(None, ge=1, le=365)


class BatchCreateInviteRequest(BaseModel):
    count: int = Field(..., ge=1, le=100)
    expires_in_days: int | None = Field(None, ge=1, le=365)


class InviteResponse(BaseModel):
    id: str
    code: str
    # active = issuable; used = consumed (terminal); expired = lapsed unused;
    # revoked = retired by an admin before use (邀请码撤销).
    status: Literal["active", "used", "expired", "revoked"]
    created_by: str | None
    used_by: str | None
    created_at: datetime
    expires_at: datetime | None
    used_at: datetime | None
    revoked_at: datetime | None = None


class InviteListResponse(BaseModel):
    data: list[InviteResponse]
    total: int
    page: int | None = None
    page_size: int | None = None
