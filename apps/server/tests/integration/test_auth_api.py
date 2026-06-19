"""End-to-end API integration tests for auth + per-user isolation (real PG).

Exercises the full HTTP chain (cookies, DI, error mapping) against a real
PostgreSQL schema. Covers: unauthenticated 401s, the register/login/me flow,
owner-scoped conversation CRUD, IDOR protection, refresh rotation + reuse
detection, login lockout, and logout.
"""

from uuid import uuid4

import httpx

_PW = "password123"


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post(
        "/v1/auth/login", json={"username": username, "password": _PW}
    )
    assert r.status_code == 200, r.text


async def _login_admin(
    client: httpx.AsyncClient, username: str, password: str
) -> None:
    r = await client.post(
        "/v1/auth/login", json={"username": username, "password": password}
    )
    assert r.status_code == 200, r.text


async def test_protected_endpoints_require_auth(client):
    assert (await client.get("/v1/conversations")).status_code == 401
    assert (
        await client.post("/v1/conversations", json={"title": "x"})
    ).status_code == 401
    assert (await client.get("/v1/auth/me")).status_code == 401


async def test_register_login_me_flow(client, make_invite):
    code = await make_invite("INV-1")
    r = await client.post(
        "/v1/auth/register",
        json={"username": "alice", "password": _PW, "invite_code": code},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["username"] == "alice" and body["id"]

    r = await client.post("/v1/auth/login", json={"username": "alice", "password": _PW})
    assert r.status_code == 200
    assert "access_token" in client.cookies
    assert "refresh_token" in client.cookies

    r = await client.get("/v1/auth/me")
    assert r.status_code == 200 and r.json()["username"] == "alice"


async def test_register_rejects_invalid_invite(client):
    r = await client.post(
        "/v1/auth/register",
        json={"username": "bob", "password": _PW, "invite_code": "NOPE"},
    )
    assert r.status_code == 422


async def test_conversation_crud_for_owner(client, make_invite):
    code = await make_invite("INV-2")
    await _register_and_login(client, code, "carol")

    r = await client.post("/v1/conversations", json={"title": "hello"})
    assert r.status_code == 201
    conv_id = r.json()["id"]

    assert (await client.get("/v1/conversations")).json()["total"] == 1

    r = await client.get(f"/v1/conversations/{conv_id}")
    assert r.status_code == 200 and r.json()["id"] == conv_id

    r = await client.patch(f"/v1/conversations/{conv_id}", json={"title": "renamed"})
    assert r.status_code == 200 and r.json()["title"] == "renamed"

    assert (await client.delete(f"/v1/conversations/{conv_id}")).status_code == 200
    assert (await client.get("/v1/conversations")).json()["total"] == 0


async def test_idor_user_cannot_touch_others_conversation(client, new_client, make_invite):
    code1 = await make_invite("INV-A")
    await _register_and_login(client, code1, "owner")
    conv_id = (
        await client.post("/v1/conversations", json={"title": "secret"})
    ).json()["id"]

    code2 = await make_invite("INV-B")
    async with new_client() as attacker:
        await _register_and_login(attacker, code2, "attacker")

        assert (await attacker.get(f"/v1/conversations/{conv_id}")).status_code == 404
        assert (
            await attacker.patch(
                f"/v1/conversations/{conv_id}", json={"title": "hacked"}
            )
        ).status_code == 404
        assert (
            await attacker.delete(f"/v1/conversations/{conv_id}")
        ).status_code == 404
        assert (
            await attacker.post(
                f"/v1/conversations/{conv_id}/messages", json={"content": "hi"}
            )
        ).status_code == 404
        assert (await attacker.get("/v1/conversations")).json()["total"] == 0

    # owner's data is untouched
    r = await client.get(f"/v1/conversations/{conv_id}")
    assert r.status_code == 200 and r.json()["title"] == "secret"


async def test_refresh_rotates_cookie(client, make_invite):
    code = await make_invite("INV-3")
    await _register_and_login(client, code, "dave")

    old_refresh = client.cookies.get("refresh_token")
    r = await client.post("/v1/auth/refresh")
    assert r.status_code == 200

    new_refresh = client.cookies.get("refresh_token")
    assert new_refresh and new_refresh != old_refresh
    # the freshly rotated access cookie still authorizes
    assert (await client.get("/v1/auth/me")).status_code == 200


async def test_refresh_reuse_detected_revokes_family(client, new_client, make_invite):
    code = await make_invite("INV-4")
    await _register_and_login(client, code, "erin")

    r1 = client.cookies.get("refresh_token")
    assert (await client.post("/v1/auth/refresh")).status_code == 200
    r2 = client.cookies.get("refresh_token")
    assert r2 != r1

    # Replay the already-rotated r1 from a clean jar -> reuse detected (401).
    async with new_client() as raw:
        resp = await raw.post(
            "/v1/auth/refresh", headers={"Cookie": f"refresh_token={r1}"}
        )
        assert resp.status_code == 401

    # Reuse must revoke the whole family, so the live r2 is now dead too.
    async with new_client() as raw:
        resp = await raw.post(
            "/v1/auth/refresh", headers={"Cookie": f"refresh_token={r2}"}
        )
        assert resp.status_code == 401


async def test_login_lockout_after_repeated_failures(client, make_invite):
    code = await make_invite("INV-5")
    await _register_and_login(client, code, "frank")

    for _ in range(5):
        r = await client.post(
            "/v1/auth/login", json={"username": "frank", "password": "wrong-pass"}
        )
        assert r.status_code == 401

    # Even the correct password is rejected while the account is locked.
    r = await client.post("/v1/auth/login", json={"username": "frank", "password": _PW})
    assert r.status_code == 401


async def test_logout_clears_cookies(client, make_invite):
    code = await make_invite("INV-6")
    await _register_and_login(client, code, "gina")
    assert (await client.get("/v1/auth/me")).status_code == 200

    assert (await client.post("/v1/auth/logout")).status_code == 200
    # cookies cleared -> protected route is unauthenticated again
    assert (await client.get("/v1/auth/me")).status_code == 401


# --- self-service account ops (账户设置: 改密码 / 改资料 / 注销) ---


async def test_change_password_keeps_session_and_rotates_secret(client, make_invite):
    code = await make_invite("INV-CP-1")
    await _register_and_login(client, code, "harry")

    r = await client.post(
        "/v1/auth/change-password",
        json={"current_password": _PW, "new_password": "newpassword456"},
    )
    assert r.status_code == 200, r.text
    # this session stays valid — the route re-issues fresh cookies
    assert (await client.get("/v1/auth/me")).status_code == 200
    # old password is dead; the new one logs in
    assert (
        await client.post(
            "/v1/auth/login", json={"username": "harry", "password": _PW}
        )
    ).status_code == 401
    assert (
        await client.post(
            "/v1/auth/login",
            json={"username": "harry", "password": "newpassword456"},
        )
    ).status_code == 200


async def test_change_password_wrong_current_rejected(client, make_invite):
    code = await make_invite("INV-CP-2")
    await _register_and_login(client, code, "iris")
    r = await client.post(
        "/v1/auth/change-password",
        json={"current_password": "wrong-pw", "new_password": "newpassword456"},
    )
    assert r.status_code == 401


async def test_change_password_requires_auth(client):
    r = await client.post(
        "/v1/auth/change-password",
        json={"current_password": _PW, "new_password": "newpassword456"},
    )
    assert r.status_code == 401


async def test_update_profile_changes_display_name_and_email(client, make_invite):
    code = await make_invite("INV-UP-1")
    await _register_and_login(client, code, "jack")

    r = await client.patch(
        "/v1/auth/me",
        json={"display_name": "Jack Jones", "email": "jack@example.com"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["display_name"] == "Jack Jones"
    assert body["email"] == "jack@example.com"
    # persisted across a fresh read
    me = (await client.get("/v1/auth/me")).json()
    assert me["display_name"] == "Jack Jones" and me["email"] == "jack@example.com"


async def test_update_profile_rejects_duplicate_email(client, new_client, make_invite):
    code1 = await make_invite("INV-UP-2")
    await _register_and_login(client, code1, "kate")
    assert (
        await client.patch("/v1/auth/me", json={"email": "shared@example.com"})
    ).status_code == 200

    code2 = await make_invite("INV-UP-3")
    async with new_client() as other:
        await _register_and_login(other, code2, "liam")
        r = await other.patch("/v1/auth/me", json={"email": "shared@example.com"})
        assert r.status_code == 422


async def test_update_profile_requires_auth(client):
    assert (
        await client.patch("/v1/auth/me", json={"display_name": "x"})
    ).status_code == 401


async def test_delete_account_anonymizes_and_frees_username(client, make_invite):
    code = await make_invite("INV-DEL-1")
    await _register_and_login(client, code, "mona")
    # give the account data so the route's conversation cascade actually runs
    assert (
        await client.post("/v1/conversations", json={"title": "to be gone"})
    ).status_code == 201

    r = await client.request("DELETE", "/v1/auth/me", json={"password": _PW})
    assert r.status_code == 200, r.text
    # cookies cleared → unauthenticated, and the old credentials are dead
    assert (await client.get("/v1/auth/me")).status_code == 401
    assert (
        await client.post(
            "/v1/auth/login", json={"username": "mona", "password": _PW}
        )
    ).status_code == 401
    # the username was anonymized away → a brand-new account can reclaim it
    code2 = await make_invite("INV-DEL-2")
    r = await client.post(
        "/v1/auth/register",
        json={"username": "mona", "password": _PW, "invite_code": code2},
    )
    assert r.status_code == 201, r.text


async def test_delete_account_wrong_password_rejected(client, make_invite):
    code = await make_invite("INV-DEL-3")
    await _register_and_login(client, code, "nate")
    r = await client.request("DELETE", "/v1/auth/me", json={"password": "wrong-pw"})
    assert r.status_code == 401
    # the account is untouched and still usable
    assert (await client.get("/v1/auth/me")).status_code == 200


async def test_delete_account_requires_auth(client):
    r = await client.request("DELETE", "/v1/auth/me", json={"password": _PW})
    assert r.status_code == 401


# --- bearer-token flow (mobile web / Capacitor shell, M2) ---


async def test_token_login_returns_tokens_and_authorizes_via_bearer(client, make_invite):
    code = await make_invite("INV-TOK-1")
    r = await client.post(
        "/v1/auth/register",
        json={"username": "mobile1", "password": _PW, "invite_code": code},
    )
    assert r.status_code == 201, r.text

    r = await client.post(
        "/v1/auth/token", json={"username": "mobile1", "password": _PW}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"] and body["refresh_token"]
    assert body["token_type"] == "bearer" and body["expires_in"] > 0
    assert body["user"]["username"] == "mobile1"
    # The bearer flow sets NO cookies (it's for capacitor:// / new-origin clients).
    assert "access_token" not in client.cookies

    # The access token alone (no cookie) authorizes a protected route.
    me = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert me.status_code == 200 and me.json()["username"] == "mobile1"


async def test_bearer_invalid_token_rejected(client):
    r = await client.get(
        "/v1/auth/me", headers={"Authorization": "Bearer not-a-real-token"}
    )
    assert r.status_code == 401


async def test_token_refresh_rotates_via_body_and_detects_reuse(client, make_invite):
    code = await make_invite("INV-TOK-2")
    await client.post(
        "/v1/auth/register",
        json={"username": "mobile2", "password": _PW, "invite_code": code},
    )
    tok = (
        await client.post(
            "/v1/auth/token", json={"username": "mobile2", "password": _PW}
        )
    ).json()

    r = await client.post(
        "/v1/auth/token/refresh", json={"refresh_token": tok["refresh_token"]}
    )
    assert r.status_code == 200, r.text
    rotated = r.json()
    assert rotated["refresh_token"] != tok["refresh_token"]
    # the rotated access token authorizes
    me = await client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {rotated['access_token']}"},
    )
    assert me.status_code == 200

    # replaying the old (already-rotated) refresh token is reuse -> 401
    assert (
        await client.post(
            "/v1/auth/token/refresh", json={"refresh_token": tok["refresh_token"]}
        )
    ).status_code == 401


async def test_token_revoke_kills_refresh(client, make_invite):
    code = await make_invite("INV-TOK-3")
    await client.post(
        "/v1/auth/register",
        json={"username": "mobile3", "password": _PW, "invite_code": code},
    )
    tok = (
        await client.post(
            "/v1/auth/token", json={"username": "mobile3", "password": _PW}
        )
    ).json()

    assert (
        await client.post(
            "/v1/auth/token/revoke", json={"refresh_token": tok["refresh_token"]}
        )
    ).status_code == 200
    # a revoked refresh token can no longer rotate
    assert (
        await client.post(
            "/v1/auth/token/refresh", json={"refresh_token": tok["refresh_token"]}
        )
    ).status_code == 401


# --- invite issuance (admin) ---


async def test_invite_endpoints_require_auth(client):
    assert (await client.post("/v1/auth/invites", json={})).status_code == 401
    assert (await client.get("/v1/auth/invites")).status_code == 401


async def test_admin_issues_invite_and_new_user_registers_with_it(client, make_admin):
    username, password = await make_admin()
    assert (
        await client.post(
            "/v1/auth/login", json={"username": username, "password": password}
        )
    ).status_code == 200

    r = await client.post("/v1/auth/invites", json={})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "active" and body["code"]
    code = body["code"]

    assert (await client.get("/v1/auth/invites")).json()["total"] == 1

    # a brand-new user registers with the freshly minted code
    r = await client.post(
        "/v1/auth/register",
        json={"username": "rookie", "password": _PW, "invite_code": code},
    )
    assert r.status_code == 201, r.text


async def test_non_admin_cannot_access_invites(client, make_invite):
    code = await make_invite("INV-USER")
    await _register_and_login(client, code, "regular")
    assert (await client.post("/v1/auth/invites", json={})).status_code == 403
    assert (await client.get("/v1/auth/invites")).status_code == 403


# --- invite revocation (邀请码撤销) ---


async def test_admin_revokes_invite_blocks_registration(client, make_admin):
    username, password = await make_admin()
    await _login_admin(client, username, password)

    body = (await client.post("/v1/auth/invites", json={})).json()
    invite_id, code = body["id"], body["code"]

    r = await client.post(f"/v1/auth/invites/{invite_id}/revoke")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "revoked"

    # the list reflects the new terminal status
    listed = (await client.get("/v1/auth/invites")).json()["data"]
    assert listed[0]["status"] == "revoked"

    # a revoked code can no longer register an account
    r = await client.post(
        "/v1/auth/register",
        json={"username": "toolate", "password": _PW, "invite_code": code},
    )
    assert r.status_code == 422


async def test_revoke_used_invite_rejected(client, new_client, make_admin):
    username, password = await make_admin()
    await _login_admin(client, username, password)
    body = (await client.post("/v1/auth/invites", json={})).json()
    invite_id, code = body["id"], body["code"]

    async with new_client() as newcomer:
        await _register_and_login(newcomer, code, "consumer")

    # the code is consumed → revoke is refused (422)
    assert (
        await client.post(f"/v1/auth/invites/{invite_id}/revoke")
    ).status_code == 422


async def test_revoke_invite_twice_rejected(client, make_admin):
    username, password = await make_admin()
    await _login_admin(client, username, password)
    invite_id = (await client.post("/v1/auth/invites", json={})).json()["id"]
    assert (
        await client.post(f"/v1/auth/invites/{invite_id}/revoke")
    ).status_code == 200
    assert (
        await client.post(f"/v1/auth/invites/{invite_id}/revoke")
    ).status_code == 422


async def test_revoke_unknown_invite_404(client, make_admin):
    username, password = await make_admin()
    await _login_admin(client, username, password)
    assert (
        await client.post(f"/v1/auth/invites/{uuid4()}/revoke")
    ).status_code == 404


async def test_non_admin_cannot_revoke_invite(client, make_invite):
    code = await make_invite("INV-REVOKE-USER")
    await _register_and_login(client, code, "regular2")
    assert (
        await client.post(f"/v1/auth/invites/{uuid4()}/revoke")
    ).status_code == 403
