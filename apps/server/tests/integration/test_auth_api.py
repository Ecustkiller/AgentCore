"""End-to-end API integration tests for auth + per-user isolation (real PG).

Exercises the full HTTP chain (cookies, DI, error mapping) against a real
PostgreSQL schema. Covers: unauthenticated 401s, the register/login/me flow,
owner-scoped conversation CRUD, IDOR protection, refresh rotation + reuse
detection, login lockout, and logout.
"""

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
