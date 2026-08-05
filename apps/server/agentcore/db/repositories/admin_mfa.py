"""Admin MFA enrollment data access."""

import json
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.db.models import AdminMfa


class AdminMfaRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def get_by_user_id(self, user_id: str) -> AdminMfa | None:
        result = await self._session.execute(
            select(AdminMfa).where(AdminMfa.user_id == user_id)
        )
        return result.scalar_one_or_none()

    async def upsert_pending(
        self,
        *,
        user_id: str,
        totp_secret_enc: bytes,
    ) -> AdminMfa:
        row = await self.get_by_user_id(user_id)
        if row is None:
            row = AdminMfa(user_id=user_id, totp_secret_enc=totp_secret_enc)
            self._session.add(row)
        else:
            row.totp_secret_enc = totp_secret_enc
            row.enabled_at = None
            row.recovery_codes_hash = None
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def enable(
        self,
        user_id: str,
        *,
        recovery_codes_hash: list[str],
    ) -> AdminMfa | None:
        row = await self.get_by_user_id(user_id)
        if row is None:
            return None
        row.enabled_at = datetime.now(UTC)
        row.recovery_codes_hash = json.dumps(recovery_codes_hash)
        await self._session.commit()
        await self._session.refresh(row)
        return row

    async def consume_recovery_code(self, user_id: str, code: str) -> bool:
        """Consume one matching recovery code (argon2id or legacy SHA-256).

        ``code`` is the normalized plaintext (lowercase hex, no dashes).
        """
        # Lazy: top-level import cycles auth ↔ db.repositories via AuthService→mfa.
        from agentcore.auth.recovery_codes import recovery_code_matches

        row = await self.get_by_user_id(user_id)
        if row is None or not row.recovery_codes_hash:
            return False
        hashes: list[str] = json.loads(row.recovery_codes_hash)
        match_idx: int | None = None
        for i, stored in enumerate(hashes):
            if recovery_code_matches(code, stored):
                match_idx = i
                break
        if match_idx is None:
            return False
        hashes.pop(match_idx)
        await self._session.execute(
            update(AdminMfa)
            .where(AdminMfa.user_id == user_id)
            .values(recovery_codes_hash=json.dumps(hashes))
        )
        await self._session.commit()
        return True

    async def delete_for_user(self, user_id: str) -> None:
        row = await self.get_by_user_id(user_id)
        if row is not None:
            await self._session.delete(row)
            await self._session.commit()
