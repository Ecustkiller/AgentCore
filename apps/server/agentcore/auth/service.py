"""Authentication service: registration, login, token refresh, logout.

Holds all auth business logic and policy:
- invite-code gated registration (D6),
- brute-force lockout (failed-attempt counting + temporary lock),
- refresh-token rotation with reuse detection (a presented token that was
  already rotated/revoked compromises the whole family -> revoke it).

Repositories do pure data access; ``security`` does hashing/JWT; the HTTP layer
stays thin. The service depends on repository instances so it is unit-testable
with in-memory fakes (no DB).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from agentcore.config import settings
from agentcore.core.errors import (
    AuthenticationError,
    NotFoundError,
    ValidationError,
)
from agentcore.core.types import new_id
from agentcore.db.models import Invite, User
from agentcore.db.repositories import (
    CredentialsRepository,
    InviteRepository,
    RefreshTokenRepository,
    UserRepository,
)
from agentcore.security import (
    create_access_token,
    generate_invite_code,
    generate_refresh_token,
    generate_temp_password,
    hash_password,
    hash_refresh_token,
    verify_password,
)

_MIN_PASSWORD_LENGTH = 8
_MAX_FAILED_ATTEMPTS = 5
_LOCKOUT_DURATION = timedelta(minutes=15)

# Sentinel for "field not provided" in a partial profile update, distinct from an
# explicit None (which clears the nullable email column).
_UNSET: Any = object()


@dataclass(frozen=True)
class TokenPair:
    """Access JWT + opaque refresh token (raw form, for the caller to set as cookies)."""

    access_token: str
    refresh_token: str


def _invite_is_valid(invite: Invite | None, now: datetime) -> bool:
    if invite is None or invite.used_at is not None or invite.revoked_at is not None:
        return False
    return not (invite.expires_at is not None and invite.expires_at <= now)


class AuthService:
    def __init__(
        self,
        *,
        users: UserRepository,
        credentials: CredentialsRepository,
        refresh_tokens: RefreshTokenRepository,
        invites: InviteRepository,
    ) -> None:
        self._users = users
        self._credentials = credentials
        self._refresh_tokens = refresh_tokens
        self._invites = invites

    async def register(
        self,
        *,
        username: str,
        password: str,
        invite_code: str,
        display_name: str | None = None,
        email: str | None = None,
    ) -> User:
        username = username.strip()
        if not username:
            raise ValidationError("请输入用户名")
        if len(password) < _MIN_PASSWORD_LENGTH:
            raise ValidationError(
                f"密码至少需要 {_MIN_PASSWORD_LENGTH} 个字符"
            )

        invite = await self._invites.get_by_code(invite_code.strip())
        if not _invite_is_valid(invite, datetime.now(UTC)):
            raise ValidationError("邀请码无效或已被使用")

        if await self._users.get_by_username(username) is not None:
            raise ValidationError("该用户名已被占用")

        user = await self._users.create(
            username=username, display_name=display_name or username, email=email
        )
        await self._credentials.create(
            user_id=user.user_id, password_hash=hash_password(password)
        )
        await self._invites.mark_used(invite.id, used_by=user.user_id)
        return user

    async def login(self, *, username: str, password: str) -> tuple[User, TokenPair]:
        user = await self._users.get_by_username(username.strip())
        creds = (
            await self._credentials.get_by_user_id(user.user_id) if user else None
        )
        # Uniform failure: never reveal whether the username exists.
        if user is None or creds is None:
            raise AuthenticationError("用户名或密码错误")

        now = datetime.now(UTC)
        if creds.locked_until is not None and creds.locked_until > now:
            raise AuthenticationError("账户已临时锁定，请稍后再试")

        if not verify_password(password, creds.password_hash):
            await self._register_failure(creds.user_id, creds.failed_attempts, now)
            raise AuthenticationError("用户名或密码错误")

        if creds.failed_attempts or creds.locked_until is not None:
            await self._credentials.reset_failure_state(user.user_id)

        tokens = await self._issue_tokens(user.user_id, family=new_id(), now=now)
        return user, tokens

    async def refresh(self, *, refresh_token: str) -> TokenPair:
        record = await self._refresh_tokens.get_by_hash(
            hash_refresh_token(refresh_token)
        )
        now = datetime.now(UTC)

        if record is None:
            raise AuthenticationError("Invalid refresh token")

        # A token already rotated or revoked being presented again means the
        # family is compromised -> revoke the whole family (reuse detection).
        if record.rotated_at is not None or record.revoked_at is not None:
            await self._refresh_tokens.revoke_family(record.token_family)
            raise AuthenticationError("Refresh token reuse detected")

        if record.expires_at <= now:
            raise AuthenticationError("Refresh token expired")

        await self._refresh_tokens.mark_rotated(record.id)
        return await self._issue_tokens(
            record.user_id, family=record.token_family, now=now
        )

    async def logout(self, *, refresh_token: str) -> None:
        record = await self._refresh_tokens.get_by_hash(
            hash_refresh_token(refresh_token)
        )
        if record is not None:
            await self._refresh_tokens.revoke_family(record.token_family)

    # --- invites (admin) ---

    async def create_invite(
        self, *, created_by: str, expires_in_days: int | None = None
    ) -> Invite:
        """Mint a single-use invite code (D6). ``expires_in_days`` is optional."""
        expires_at = (
            datetime.now(UTC) + timedelta(days=expires_in_days)
            if expires_in_days is not None
            else None
        )
        return await self._invites.create(
            code=generate_invite_code(),
            created_by=created_by,
            expires_at=expires_at,
        )

    async def list_invites(self, *, limit: int = 100) -> Sequence[Invite]:
        return await self._invites.list_recent(limit=limit)

    async def revoke_invite(self, *, invite_id: str) -> Invite:
        """Retire an unused invite so it can no longer register an account (邀请码撤销).

        Only a still-active code can be revoked: a used one is already consumed and an
        already-revoked one is a no-op — both raise rather than silently succeed, so the
        admin gets clear feedback. (Expired-unused codes are still revocable: it makes
        their retirement explicit instead of relying on the time check.)
        """
        invite = await self._invites.get_by_id(invite_id)
        if invite is None:
            raise NotFoundError("邀请码不存在")
        if invite.used_at is not None:
            raise ValidationError("该邀请码已被使用，无法撤销")
        if invite.revoked_at is not None:
            raise ValidationError("该邀请码已撤销")
        revoked = await self._invites.revoke(invite_id, revoked_at=datetime.now(UTC))
        if revoked is None:  # pragma: no cover - existence just validated above
            raise NotFoundError("邀请码不存在")
        return revoked

    # --- admin account ops ---

    async def admin_reset_password(self, *, user_id: str) -> str:
        """Reset an account's password to a fresh one-off, returned once for the admin
        to hand over (重置密码). Revokes the user's refresh tokens (forces re-login on
        every device) and clears any brute-force lockout. The plaintext is never stored
        — only its hash. Raises ``NotFoundError`` for an unknown account.
        """
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise NotFoundError("用户不存在")
        creds = await self._credentials.get_by_user_id(user_id)
        if creds is None:  # pragma: no cover - an account always has credentials
            raise NotFoundError("用户凭据不存在")

        temp_password = generate_temp_password()
        await self._credentials.set_password(user_id, hash_password(temp_password))
        # Force re-login everywhere: the old sessions must not outlive the reset.
        await self._refresh_tokens.revoke_all_for_user(user_id)
        return temp_password

    async def admin_delete_account(
        self, *, actor_id: str, user_id: str
    ) -> tuple[User, str | None]:
        """Admin-initiated 注销 (account deletion): soft-delete + anonymize the target
        and revoke its sessions — no password (the admin role gate + the client's
        二次确认 prove intent, and the operator can't know the target's password).

        Refuses self-deletion (``不能注销自己的账户``): the no-self-lockout guard that,
        with accounts never hard-deleted, keeps the platform at ≥1 active admin (the
        same invariant as ``AdminService.update_user``). Idempotent for an already-注销
        account (returns it untouched, no re-revoke). Returns ``(tombstone_record,
        pre-deletion avatar_key)`` so the route can GC the avatar object *after*
        anonymization has nulled the key. Cross-domain cleanup (conversations / shares
        / BYOK) is the route's, via the shared ``cleanup_account_resources``. Raises
        ``NotFoundError`` for an unknown account.
        """
        if actor_id == user_id:
            raise ValidationError("不能注销自己的账户")
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise NotFoundError("用户不存在")
        if user.deleted_at is not None:
            return user, None
        avatar_key = user.avatar_key
        updated = await self._users.soft_delete(user_id)
        await self._refresh_tokens.revoke_all_for_user(user_id)
        return (updated or user), avatar_key

    # --- self-service account ops (账户设置: 改密码 / 改资料 / 注销) ---

    async def change_password(
        self, *, user_id: str, current_password: str, new_password: str
    ) -> TokenPair:
        """Change a logged-in user's password (修改密码), verifying the current one.

        Confirms the current password before rotating to the new one, enforces the same
        minimum length as registration, then revokes every refresh family (all other
        devices must re-login) and mints a fresh pair for the current session so the
        active device stays signed in. Raises ``AuthenticationError`` if the current
        password is wrong, ``ValidationError`` if the new password is too weak/unchanged.
        """
        creds = await self._credentials.get_by_user_id(user_id)
        if creds is None or not verify_password(
            current_password, creds.password_hash
        ):
            raise AuthenticationError("当前密码不正确")
        if len(new_password) < _MIN_PASSWORD_LENGTH:
            raise ValidationError(f"密码至少需要 {_MIN_PASSWORD_LENGTH} 个字符")
        if verify_password(new_password, creds.password_hash):
            raise ValidationError("新密码不能与当前密码相同")
        await self._credentials.set_password(user_id, hash_password(new_password))
        await self._refresh_tokens.revoke_all_for_user(user_id)
        return await self._issue_tokens(
            user_id, family=new_id(), now=datetime.now(UTC)
        )

    async def update_profile(
        self,
        *,
        user_id: str,
        display_name: str | object = _UNSET,
        email: str | None | object = _UNSET,
    ) -> User:
        """Update a user's profile (个人资料编辑: 显示名 / 邮箱), returning the new row.

        Patch semantics — only the passed fields change. Display name must be
        non-empty; email must be unique (a collision with another live account → 422),
        and an explicit ``None``/blank clears it. Raises ``NotFoundError`` for an
        unknown user, ``ValidationError`` on an empty display name or a taken email.
        """
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise NotFoundError("用户不存在")

        changed: dict[str, object | None] = {}
        if display_name is not _UNSET:
            name = display_name.strip() if isinstance(display_name, str) else ""
            if not name:
                raise ValidationError("显示名不能为空")
            changed["display_name"] = name
        if email is not _UNSET:
            normalized = email.strip() if isinstance(email, str) else ""
            if not normalized:
                changed["email"] = None
            else:
                existing = await self._users.get_by_email(normalized)
                if existing is not None and existing.user_id != user_id:
                    raise ValidationError("该邮箱已被占用")
                changed["email"] = normalized

        if not changed:
            return user
        updated = await self._users.update(user_id, **changed)
        return updated or user

    async def delete_account(self, *, user_id: str, password: str) -> None:
        """Self-service account deletion (注销账户): verify password, then soft-delete.

        Confirms the password — a destructive, irreversible action must prove intent —
        then soft-deletes + anonymizes the account (frees username/email, disables it)
        and revokes all refresh families. Cross-domain cleanup (the user's conversations
        + BYOK key) is the route's job, since those repos live outside the auth domain.
        Raises ``NotFoundError`` for an unknown user, ``AuthenticationError`` if the
        password is wrong.
        """
        user = await self._users.get_by_id(user_id)
        if user is None:
            raise NotFoundError("用户不存在")
        creds = await self._credentials.get_by_user_id(user_id)
        if creds is None or not verify_password(password, creds.password_hash):
            raise AuthenticationError("密码不正确")
        await self._users.soft_delete(user_id)
        await self._refresh_tokens.revoke_all_for_user(user_id)

    # --- internals ---

    async def _issue_tokens(
        self, user_id: str, *, family: str, now: datetime
    ) -> TokenPair:
        raw, token_hash = generate_refresh_token()
        expires_at = now + timedelta(days=settings.jwt_refresh_token_expire_days)
        await self._refresh_tokens.create(
            user_id=user_id,
            token_hash=token_hash,
            token_family=family,
            expires_at=expires_at,
        )
        return TokenPair(
            access_token=create_access_token(user_id), refresh_token=raw
        )

    async def _register_failure(
        self, user_id: str, current_attempts: int, now: datetime
    ) -> None:
        new_attempts = current_attempts + 1
        locked_until = (
            now + _LOCKOUT_DURATION if new_attempts >= _MAX_FAILED_ATTEMPTS else None
        )
        await self._credentials.set_failure_state(
            user_id, failed_attempts=new_attempts, locked_until=locked_until
        )
