"""Auth / account-security data access: credentials, BYOK keys, refresh tokens,
invites."""

from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.types import new_id
from agentcore.db.models import Credentials, Invite, RefreshToken, UserLlmKey


def _invite_status_clause(status: str, *, now: datetime):
    """SQL filter mirroring ``_invite_status`` in api/routes/auth.py."""
    if status == "used":
        return Invite.used_at.isnot(None)
    if status == "revoked":
        return and_(Invite.used_at.is_(None), Invite.revoked_at.isnot(None))
    if status == "expired":
        return and_(
            Invite.used_at.is_(None),
            Invite.revoked_at.is_(None),
            Invite.expires_at.isnot(None),
            Invite.expires_at <= now,
        )
    if status == "active":
        return and_(
            Invite.used_at.is_(None),
            Invite.revoked_at.is_(None),
            or_(Invite.expires_at.is_(None), Invite.expires_at > now),
        )
    raise ValueError(f"unknown invite status filter: {status}")


class CredentialsRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(self, *, user_id: str, password_hash: str) -> Credentials:
        cred = Credentials(user_id=user_id, password_hash=password_hash)
        self._session.add(cred)
        await self._session.commit()
        await self._session.refresh(cred)
        return cred

    async def get_by_user_id(self, user_id: str) -> Credentials | None:
        result = await self._session.execute(
            select(Credentials).where(Credentials.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def set_failure_state(
        self, user_id: str, *, failed_attempts: int, locked_until: datetime | None
    ) -> None:
        await self._session.execute(
            update(Credentials)
            .where(Credentials.user_id == user_id)
            .values(failed_attempts=failed_attempts, locked_until=locked_until)
        )
        await self._session.commit()

    async def reset_failure_state(self, user_id: str) -> None:
        await self._session.execute(
            update(Credentials)
            .where(Credentials.user_id == user_id)
            .values(failed_attempts=0, locked_until=None)
        )
        await self._session.commit()

    async def set_password(
        self,
        user_id: str,
        password_hash: str,
        *,
        must_change: bool | None = None,
    ) -> None:
        """Replace the stored hash and clear any lockout. An admin reset both rotates
        the secret and unlocks the account (a forgotten password may have tripped the
        brute-force lock). ``must_change`` optionally sets ``password_must_change``."""
        values: dict = {
            "password_hash": password_hash,
            "failed_attempts": 0,
            "locked_until": None,
        }
        if must_change is not None:
            values["password_must_change"] = must_change
        await self._session.execute(
            update(Credentials).where(Credentials.user_id == user_id).values(**values)
        )
        await self._session.commit()


class UserLlmKeyRepository:
    """The user's single BYOK DeepSeek key (one row per user). Stores only the
    AES-256-GCM ciphertext; encryption/decryption is the service layer's job.
    """

    def __init__(self, session: AsyncSession):
        self._session = session

    async def get_by_user_id(self, user_id: str) -> UserLlmKey | None:
        result = await self._session.execute(
            select(UserLlmKey).where(UserLlmKey.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def upsert(self, *, user_id: str, api_key_enc: bytes) -> UserLlmKey:
        """Insert or replace the user's key, resetting status to 'unchecked' (a
        freshly set key has not been connectivity-tested yet)."""
        row = await self.get_by_user_id(user_id)
        if row is not None:
            row.api_key_enc = api_key_enc
            row.status = "unchecked"
            await self._session.commit()
            await self._session.refresh(row)
            return row
        row = UserLlmKey(user_id=user_id, api_key_enc=api_key_enc, status="unchecked")
        self._session.add(row)
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def update_status(self, user_id: str, status: str) -> None:
        await self._session.execute(
            update(UserLlmKey).where(UserLlmKey.user_id == user_id).values(status=status)
        )
        await self._session.commit()

    async def delete(self, user_id: str) -> None:
        await self._session.execute(delete(UserLlmKey).where(UserLlmKey.user_id == user_id))
        await self._session.commit()


class RefreshTokenRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        user_id: str,
        token_hash: str,
        token_family: str,
        expires_at: datetime,
        client_aud: str = "product",
    ) -> RefreshToken:
        token = RefreshToken(
            id=new_id(),
            user_id=user_id,
            token_hash=token_hash,
            token_family=token_family,
            expires_at=expires_at,
            client_aud=client_aud,
        )
        self._session.add(token)
        await self._session.commit()
        await self._session.refresh(token)
        return token

    async def get_by_hash(self, token_hash: str) -> RefreshToken | None:
        result = await self._session.execute(
            select(RefreshToken).where(RefreshToken.token_hash == token_hash)
        )
        return result.scalar_one_or_none()

    async def mark_rotated(self, token_id: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(RefreshToken.id == token_id)
            .values(rotated_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def revoke_family(self, token_family: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.token_family == token_family,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def revoke_all_for_user(self, user_id: str) -> None:
        await self._session.execute(
            update(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
            )
            .values(revoked_at=datetime.now(UTC))
        )
        await self._session.commit()


class InviteRepository:
    def __init__(self, session: AsyncSession):
        self._session = session

    async def create(
        self,
        *,
        code: str,
        created_by: str | None = None,
        expires_at: datetime | None = None,
    ) -> Invite:
        invite = Invite(
            id=new_id(),
            code=code,
            created_by=created_by,
            expires_at=expires_at,
        )
        self._session.add(invite)
        await self._session.commit()
        await self._session.refresh(invite)
        return invite

    async def create_many(
        self,
        *,
        codes: list[str],
        created_by: str | None = None,
        expires_at: datetime | None = None,
    ) -> Sequence[Invite]:
        invites = [
            Invite(
                id=new_id(),
                code=code,
                created_by=created_by,
                expires_at=expires_at,
            )
            for code in codes
        ]
        self._session.add_all(invites)
        await self._session.commit()
        for invite in invites:
            await self._session.refresh(invite)
        return invites

    async def get_by_code(self, code: str) -> Invite | None:
        result = await self._session.execute(select(Invite).where(Invite.code == code))
        return result.scalar_one_or_none()

    async def get_by_id(self, invite_id: str) -> Invite | None:
        result = await self._session.execute(select(Invite).where(Invite.id == invite_id))
        return result.scalar_one_or_none()

    async def list_recent(self, *, limit: int = 100) -> Sequence[Invite]:
        result = await self._session.execute(
            select(Invite).order_by(Invite.created_at.desc()).limit(limit)
        )
        return result.scalars().all()

    async def list_page(
        self,
        *,
        offset: int,
        limit: int,
        status: str | None = None,
        now: datetime | None = None,
    ) -> tuple[Sequence[Invite], int]:
        now = now or datetime.now(UTC)
        filters = [_invite_status_clause(status, now=now)] if status is not None else []

        total_result = await self._session.execute(
            select(func.count()).select_from(Invite).where(*filters)
        )
        total = total_result.scalar_one()

        result = await self._session.execute(
            select(Invite)
            .where(*filters)
            .order_by(Invite.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
        return result.scalars().all(), total

    async def mark_used(self, invite_id: str, *, used_by: str) -> None:
        await self._session.execute(
            update(Invite)
            .where(Invite.id == invite_id)
            .values(used_by=used_by, used_at=datetime.now(UTC))
        )
        await self._session.commit()

    async def revoke(self, invite_id: str, *, revoked_at: datetime) -> Invite | None:
        """Stamp ``revoked_at`` and return the fresh row (ORM mutate + refresh so the
        returned object is fully populated under async expire-on-commit)."""
        invite = await self.get_by_id(invite_id)
        if invite is None:
            return None
        invite.revoked_at = revoked_at
        await self._session.commit()
        await self._session.refresh(invite)
        return invite
