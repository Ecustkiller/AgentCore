"""Unit tests for AuthService using in-memory fake repositories (no DB)."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from agentcore.auth import AuthService
from agentcore.core.errors import AuthenticationError, ValidationError
from agentcore.core.types import new_id
from agentcore.security import decode_access_token, hash_refresh_token

_PW = "password123"


class FakeUsers:
    def __init__(self) -> None:
        self._by_id: dict = {}

    async def get_by_id(self, user_id):
        return self._by_id.get(user_id)

    async def get_by_username(self, username):
        return next((u for u in self._by_id.values() if u.username == username), None)

    async def create(
        self, *, username, display_name=None, email=None, role="user", status="active"
    ):
        user = SimpleNamespace(
            user_id=new_id(),
            username=username,
            display_name=display_name or "",
            email=email,
            role=role,
            status=status,
        )
        self._by_id[user.user_id] = user
        return user


class FakeCredentials:
    def __init__(self) -> None:
        self._by_user: dict = {}

    async def create(self, *, user_id, password_hash):
        cred = SimpleNamespace(
            user_id=user_id,
            password_hash=password_hash,
            failed_attempts=0,
            locked_until=None,
        )
        self._by_user[user_id] = cred
        return cred

    async def get_by_user_id(self, user_id):
        return self._by_user.get(user_id)

    async def set_failure_state(self, user_id, *, failed_attempts, locked_until):
        cred = self._by_user[user_id]
        cred.failed_attempts = failed_attempts
        cred.locked_until = locked_until

    async def reset_failure_state(self, user_id):
        cred = self._by_user[user_id]
        cred.failed_attempts = 0
        cred.locked_until = None


class FakeRefreshTokens:
    def __init__(self) -> None:
        self.records: dict = {}

    async def create(self, *, user_id, token_hash, token_family, expires_at):
        rec = SimpleNamespace(
            id=new_id(),
            user_id=user_id,
            token_hash=token_hash,
            token_family=token_family,
            expires_at=expires_at,
            revoked_at=None,
            rotated_at=None,
        )
        self.records[rec.id] = rec
        return rec

    async def get_by_hash(self, token_hash):
        return next(
            (r for r in self.records.values() if r.token_hash == token_hash), None
        )

    async def mark_rotated(self, token_id):
        self.records[token_id].rotated_at = datetime.now(UTC)

    async def revoke_family(self, token_family):
        for rec in self.records.values():
            if rec.token_family == token_family and rec.revoked_at is None:
                rec.revoked_at = datetime.now(UTC)

    async def revoke_all_for_user(self, user_id):
        for rec in self.records.values():
            if rec.user_id == user_id and rec.revoked_at is None:
                rec.revoked_at = datetime.now(UTC)


class FakeInvites:
    def __init__(self) -> None:
        self.records: dict = {}

    async def create(self, *, code, created_by=None, expires_at=None):
        inv = SimpleNamespace(
            id=new_id(),
            code=code,
            created_by=created_by,
            used_by=None,
            expires_at=expires_at,
            used_at=None,
        )
        self.records[inv.id] = inv
        return inv

    async def get_by_code(self, code):
        return next((i for i in self.records.values() if i.code == code), None)

    async def mark_used(self, invite_id, *, used_by):
        self.records[invite_id].used_by = used_by
        self.records[invite_id].used_at = datetime.now(UTC)


def _make():
    users = FakeUsers()
    creds = FakeCredentials()
    tokens = FakeRefreshTokens()
    invites = FakeInvites()
    svc = AuthService(
        users=users, credentials=creds, refresh_tokens=tokens, invites=invites
    )
    return svc, users, creds, tokens, invites


# --- register ---


async def test_register_success():
    svc, _users, creds, _tokens, invites = _make()
    await invites.create(code="GOOD")
    user = await svc.register(username="alice", password=_PW, invite_code="GOOD")
    assert user.username == "alice"
    cred = await creds.get_by_user_id(user.user_id)
    assert cred is not None and cred.password_hash != _PW
    inv = await invites.get_by_code("GOOD")
    assert inv.used_by == user.user_id and inv.used_at is not None


async def test_register_rejects_unknown_invite():
    svc, *_ = _make()
    with pytest.raises(ValidationError):
        await svc.register(username="bob", password=_PW, invite_code="NOPE")


async def test_register_rejects_used_invite():
    svc, _u, _c, _t, invites = _make()
    await invites.create(code="ONCE")
    await svc.register(username="bob", password=_PW, invite_code="ONCE")
    with pytest.raises(ValidationError):
        await svc.register(username="carol", password=_PW, invite_code="ONCE")


async def test_register_rejects_duplicate_username():
    svc, _u, _c, _t, invites = _make()
    await invites.create(code="C1")
    await invites.create(code="C2")
    await svc.register(username="dave", password=_PW, invite_code="C1")
    with pytest.raises(ValidationError):
        await svc.register(username="dave", password=_PW, invite_code="C2")


async def test_register_rejects_weak_password():
    svc, _u, _c, _t, invites = _make()
    await invites.create(code="C1")
    with pytest.raises(ValidationError):
        await svc.register(username="eve", password="short", invite_code="C1")


# --- login ---


async def test_login_success_issues_tokens():
    svc, _u, _c, tokens, invites = _make()
    await invites.create(code="C1")
    user = await svc.register(username="frank", password=_PW, invite_code="C1")
    logged_user, pair = await svc.login(username="frank", password=_PW)
    assert logged_user.user_id == user.user_id
    assert decode_access_token(pair.access_token) == user.user_id
    assert pair.refresh_token
    assert len(tokens.records) == 1


async def test_login_wrong_password_raises_and_counts():
    svc, _u, creds, _t, invites = _make()
    await invites.create(code="C1")
    user = await svc.register(username="grace", password=_PW, invite_code="C1")
    with pytest.raises(AuthenticationError):
        await svc.login(username="grace", password="wrong-pw")
    cred = await creds.get_by_user_id(user.user_id)
    assert cred.failed_attempts == 1


async def test_login_locks_after_max_attempts():
    svc, _u, creds, _t, invites = _make()
    await invites.create(code="C1")
    user = await svc.register(username="heidi", password=_PW, invite_code="C1")
    for _ in range(5):
        with pytest.raises(AuthenticationError):
            await svc.login(username="heidi", password="wrong-pw")
    cred = await creds.get_by_user_id(user.user_id)
    assert cred.locked_until is not None
    # correct password is still rejected while locked
    with pytest.raises(AuthenticationError):
        await svc.login(username="heidi", password=_PW)


async def test_login_unknown_user_raises():
    svc, *_ = _make()
    with pytest.raises(AuthenticationError):
        await svc.login(username="ghost", password=_PW)


async def test_login_resets_failures_on_success():
    svc, _u, creds, _t, invites = _make()
    await invites.create(code="C1")
    user = await svc.register(username="ivan", password=_PW, invite_code="C1")
    with pytest.raises(AuthenticationError):
        await svc.login(username="ivan", password="wrong-pw")
    await svc.login(username="ivan", password=_PW)
    cred = await creds.get_by_user_id(user.user_id)
    assert cred.failed_attempts == 0 and cred.locked_until is None


# --- refresh / logout ---


async def test_refresh_rotates_token():
    svc, _u, _c, tokens, invites = _make()
    await invites.create(code="C1")
    await svc.register(username="judy", password=_PW, invite_code="C1")
    _, pair = await svc.login(username="judy", password=_PW)
    new_pair = await svc.refresh(refresh_token=pair.refresh_token)
    assert new_pair.refresh_token != pair.refresh_token
    assert len(tokens.records) == 2
    rotated = [r for r in tokens.records.values() if r.rotated_at is not None]
    assert len(rotated) == 1


async def test_refresh_reuse_detected_revokes_family():
    svc, _u, _c, tokens, invites = _make()
    await invites.create(code="C1")
    await svc.register(username="ken", password=_PW, invite_code="C1")
    _, pair = await svc.login(username="ken", password=_PW)
    await svc.refresh(refresh_token=pair.refresh_token)  # rotate once
    with pytest.raises(AuthenticationError):
        await svc.refresh(refresh_token=pair.refresh_token)  # reuse old token
    assert all(r.revoked_at is not None for r in tokens.records.values())


async def test_refresh_unknown_token_raises():
    svc, *_ = _make()
    with pytest.raises(AuthenticationError):
        await svc.refresh(refresh_token="does-not-exist")


async def test_refresh_expired_token_raises():
    svc, _u, _c, tokens, invites = _make()
    await invites.create(code="C1")
    await svc.register(username="leo", password=_PW, invite_code="C1")
    _, pair = await svc.login(username="leo", password=_PW)
    rec = await tokens.get_by_hash(hash_refresh_token(pair.refresh_token))
    rec.expires_at = datetime.now(UTC) - timedelta(seconds=1)
    with pytest.raises(AuthenticationError):
        await svc.refresh(refresh_token=pair.refresh_token)


async def test_logout_revokes_family():
    svc, _u, _c, tokens, invites = _make()
    await invites.create(code="C1")
    await svc.register(username="mia", password=_PW, invite_code="C1")
    _, pair = await svc.login(username="mia", password=_PW)
    await svc.logout(refresh_token=pair.refresh_token)
    assert all(r.revoked_at is not None for r in tokens.records.values())
    with pytest.raises(AuthenticationError):
        await svc.refresh(refresh_token=pair.refresh_token)
