"""Integration tests for the admin console API (``/v1/admin/*``, real PG).

Covers the 用户管理 P0 surface end-to-end over the full HTTP chain (cookies, DI,
error mapping): the ``AdminUser`` gate (401/403), the account roster (pagination
+ substring filter), role/status/quota patches with tri-state quota semantics,
the disable→access-revoked chain, and the no-self-lockout guard.
"""

import httpx

from agentcore.db.repositories import UserRepository

_PW = "password123"


async def _login(client: httpx.AsyncClient, username: str, password: str) -> None:
    r = await client.post(
        "/v1/auth/login", json={"username": username, "password": password}
    )
    assert r.status_code == 200, r.text


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    await _login(client, username, _PW)


async def _seed_user(
    session_factory, username: str, *, role: str = "user", status: str = "active"
) -> str:
    async with session_factory() as session:
        user = await UserRepository(session).create(
            username=username, display_name=username, role=role, status=status
        )
    return user.user_id


# --- the AdminUser gate ---


async def test_admin_users_require_auth(client):
    assert (await client.get("/v1/admin/users")).status_code == 401
    assert (
        await client.patch("/v1/admin/users/anyone", json={"role": "admin"})
    ).status_code == 401


async def test_non_admin_cannot_access_admin_users(client, make_invite):
    code = await make_invite("INV-NA")
    await _register_and_login(client, code, "regular")
    me = (await client.get("/v1/auth/me")).json()["id"]

    assert (await client.get("/v1/admin/users")).status_code == 403
    # a non-admin can't even self-escalate: the gate rejects before the service runs
    assert (
        await client.patch(f"/v1/admin/users/{me}", json={"role": "admin"})
    ).status_code == 403


# --- roster: listing, filter, pagination ---


async def test_admin_lists_roster_with_quota_fields(client, make_admin, session_factory):
    username, password = await make_admin()
    await _login(client, username, password)
    await _seed_user(session_factory, "alice")
    await _seed_user(session_factory, "bob")

    r = await client.get("/v1/admin/users")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["total"] == 3  # admin + alice + bob
    assert body["page"] == 1 and body["page_size"] == 20
    assert {"admin", "alice", "bob"} <= {u["username"] for u in body["data"]}
    # rows carry the admin-only account + quota fields (richer than the self-view)
    row = body["data"][0]
    for key in ("status", "is_unlimited", "quota_daily_tokens", "role", "created_at"):
        assert key in row


async def test_admin_roster_filter_and_pagination(client, make_admin, session_factory):
    username, password = await make_admin()
    await _login(client, username, password)
    await _seed_user(session_factory, "alice")
    await _seed_user(session_factory, "alicia")
    await _seed_user(session_factory, "bob")

    r = await client.get("/v1/admin/users", params={"q": "alic"})
    body = r.json()
    assert body["total"] == 2
    assert {u["username"] for u in body["data"]} == {"alice", "alicia"}

    r = await client.get("/v1/admin/users", params={"page_size": 2})
    body = r.json()
    assert body["page_size"] == 2 and len(body["data"]) == 2 and body["total"] == 4


# --- role / status / quota patches ---


async def test_admin_changes_role(client, make_admin, session_factory):
    username, password = await make_admin()
    await _login(client, username, password)
    uid = await _seed_user(session_factory, "alice")

    r = await client.patch(f"/v1/admin/users/{uid}", json={"role": "admin"})
    assert r.status_code == 200 and r.json()["role"] == "admin"
    r = await client.patch(f"/v1/admin/users/{uid}", json={"role": "user"})
    assert r.json()["role"] == "user"


async def test_admin_disable_revokes_target_access(
    client, new_client, make_admin
):
    username, password = await make_admin()
    await _login(client, username, password)
    code = (await client.post("/v1/auth/invites", json={})).json()["code"]

    async with new_client() as target:
        await _register_and_login(target, code, "victim")
        uid = (await target.get("/v1/auth/me")).json()["id"]
        assert (await target.get("/v1/auth/me")).status_code == 200

        r = await client.patch(f"/v1/admin/users/{uid}", json={"status": "disabled"})
        assert r.status_code == 200 and r.json()["status"] == "disabled"

        # the disabled account is refused on its very next request (status re-checked)
        assert (await target.get("/v1/auth/me")).status_code == 401


async def test_admin_sets_then_clears_quota(client, make_admin, session_factory):
    username, password = await make_admin()
    await _login(client, username, password)
    uid = await _seed_user(session_factory, "alice")

    r = await client.patch(
        f"/v1/admin/users/{uid}",
        json={
            "is_unlimited": True,
            "quota_daily_tokens": 1000,
            "quota_monthly_cost_usd": 5.5,
            "quota_daily_requests": 50,
        },
    )
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["is_unlimited"] is True
    assert b["quota_daily_tokens"] == 1000
    assert b["quota_monthly_cost_usd"] == 5.5
    assert b["quota_daily_requests"] == 50

    # explicit null clears one override (inherit global); untouched fields persist
    r = await client.patch(f"/v1/admin/users/{uid}", json={"quota_daily_tokens": None})
    b = r.json()
    assert b["quota_daily_tokens"] is None
    assert b["quota_daily_requests"] == 50


# --- guards & validation ---


async def test_admin_cannot_self_demote_or_self_disable(client, make_admin):
    username, password = await make_admin()
    await _login(client, username, password)
    me = (await client.get("/v1/auth/me")).json()["id"]

    assert (
        await client.patch(f"/v1/admin/users/{me}", json={"role": "user"})
    ).status_code == 422
    assert (
        await client.patch(f"/v1/admin/users/{me}", json={"status": "disabled"})
    ).status_code == 422
    # a harmless self-patch (own quota) is still allowed
    r = await client.patch(f"/v1/admin/users/{me}", json={"quota_daily_tokens": 999})
    assert r.status_code == 200 and r.json()["quota_daily_tokens"] == 999


async def test_admin_update_unknown_user_404(client, make_admin):
    username, password = await make_admin()
    await _login(client, username, password)
    r = await client.patch(
        "/v1/admin/users/00000000-0000-0000-0000-000000000000",
        json={"role": "admin"},
    )
    assert r.status_code == 404


async def test_admin_rejects_invalid_values(client, make_admin, session_factory):
    username, password = await make_admin()
    await _login(client, username, password)
    uid = await _seed_user(session_factory, "alice")

    assert (
        await client.patch(f"/v1/admin/users/{uid}", json={"role": "superuser"})
    ).status_code == 422
    assert (
        await client.patch(f"/v1/admin/users/{uid}", json={"quota_daily_tokens": -5})
    ).status_code == 422
