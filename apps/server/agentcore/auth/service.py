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

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from agentcore.config import settings
from agentcore.core.errors import AuthenticationError, ValidationError
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
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    verify_password,
)

_MIN_PASSWORD_LENGTH = 8
_MAX_FAILED_ATTEMPTS = 5
_LOCKOUT_DURATION = timedelta(minutes=15)


@dataclass(frozen=True)
class TokenPair:
    """Access JWT + opaque refresh token (raw form, for the caller to set as cookies)."""

    access_token: str
    refresh_token: str


def _invite_is_valid(invite: Invite | None, now: datetime) -> bool:
    if invite is None or invite.used_at is not None:
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
            raise ValidationError("Username is required")
        if len(password) < _MIN_PASSWORD_LENGTH:
            raise ValidationError(
                f"Password must be at least {_MIN_PASSWORD_LENGTH} characters"
            )

        invite = await self._invites.get_by_code(invite_code.strip())
        if not _invite_is_valid(invite, datetime.now(UTC)):
            raise ValidationError("Invalid or already-used invite code")

        if await self._users.get_by_username(username) is not None:
            raise ValidationError("Username already taken")

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
            raise AuthenticationError("Invalid username or password")

        now = datetime.now(UTC)
        if creds.locked_until is not None and creds.locked_until > now:
            raise AuthenticationError("Account temporarily locked. Try again later.")

        if not verify_password(password, creds.password_hash):
            await self._register_failure(creds.user_id, creds.failed_attempts, now)
            raise AuthenticationError("Invalid username or password")

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
