"""Admin account-management service (用户管理 business rules).

The 403 role gate is applied declaratively at the route via the ``AdminUser``
dependency; this service owns the rules that the route must not bypass:

- **No self-lockout.** An admin can't demote (admin→user) or disable their own
  account. Since accounts are never hard-deleted and the only path to zero active
  admins is the last admin acting on themselves, this single guard guarantees the
  platform always retains at least one active admin.

Schema ↔ ORM mapping stays in the API layer; this service speaks in domain
objects (``User``) and the repository's quota sentinel convention.
"""

from agentcore.core.errors import NotFoundError, ValidationError
from agentcore.db.models import User
from agentcore.db.repositories import UserRepository


class AdminService:
    def __init__(self, users: UserRepository) -> None:
        self._users = users

    async def list_users(
        self, *, page: int, page_size: int, query: str | None = None
    ) -> tuple[list[User], int]:
        """One page of the account roster (newest-first), with the total count."""
        offset = (page - 1) * page_size
        return await self._users.list_all(
            limit=page_size, offset=offset, query=query
        )

    async def update_user(
        self,
        *,
        actor: User,
        user_id: str,
        role: str | None = None,
        status: str | None = None,
        quota: dict[str, object] | None = None,
    ) -> User:
        """Apply a partial role / status / quota change and return the fresh record.

        ``role``/``status`` ``None`` = leave unchanged. ``quota`` (already resolved
        by the route from the request's set-fields) is forwarded verbatim to
        ``UserRepository.set_quota`` (its keys carry the clear-vs-set semantics);
        a falsy ``quota`` leaves all quota fields untouched.
        """
        target = await self._users.get_by_id(user_id)
        if target is None:
            raise NotFoundError("用户不存在")

        # No self-lockout: refuse a self-change that would revoke the caller's own
        # admin access (keeps ≥1 active admin at all times).
        if target.user_id == actor.user_id:
            if role is not None and role != target.role:
                raise ValidationError("不能修改自己的角色")
            if status is not None and status != target.status:
                raise ValidationError("不能停用自己的账户")

        if role is not None:
            await self._users.set_role(user_id, role)
        if status is not None:
            await self._users.set_status(user_id, status)
        if quota:
            await self._users.set_quota(user_id, **quota)

        refreshed = await self._users.get_by_id(user_id)
        if refreshed is None:  # pragma: no cover - row was just read above
            raise NotFoundError("用户不存在")
        return refreshed
