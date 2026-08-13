"""Integration: CSRF token issuance + enforcement on the real cookie login flow.

``client`` echoes the token like apps/desktop and apps/admin do; ``naive_client``
never sends one, so enforcement is asserted against a client that genuinely has no
token rather than one the fixture quietly fixed up.
"""

from agentcore.core.error_codes import ErrorCode
from agentcore.middleware.csrf import CSRF_HEADER
from agentcore.security import sign_csrf_token
from tests.integration.conftest import client_platform_headers, register_and_login

_PW = "password123"
_DESKTOP = client_platform_headers()


async def _login(client, username: str) -> str:
    await client.post("/v1/auth/register", json={"username": username, "password": _PW})
    r = await client.post(
        "/v1/auth/login",
        json={"username": username, "password": _PW},
        headers=_DESKTOP,
    )
    assert r.status_code == 200, r.text
    return r.headers[CSRF_HEADER]


async def test_login_issues_csrf_and_allows_mutating_request(naive_client):
    csrf = await _login(naive_client, "csrfint")
    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "csrf-ok"},
        headers={CSRF_HEADER: csrf},
    )
    assert r.status_code == 201


async def test_only_the_handshake_hands_out_a_token(naive_client):
    """Login arms the session; ordinary traffic does not re-arm it.

    The token outlives every access cookie and cannot be revoked, so it rides the
    handshakes and nothing else — an ordinary read and an accepted write both come
    back bare, and the one login minted keeps working throughout.
    """
    csrf = await _login(naive_client, "csrfrefresh")

    listed = await naive_client.get("/v1/conversations")
    assert listed.status_code == 200
    assert CSRF_HEADER not in listed.headers

    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "ordinary-write"},
        headers={CSRF_HEADER: csrf},
    )
    assert r.status_code == 201
    assert CSRF_HEADER not in r.headers


async def test_me_arms_a_cold_start_cookie_session(naive_client):
    """The identity handshake is an issuing moment too, because it is the only one a
    cold start makes.

    A relaunched client resumes on the access cookie its partition persisted and has
    lost the in-memory token from whichever login opened the session — the state
    ``naive_client`` is in below, since it keeps cookies but drops the handshake
    header. Unarmed here, its very first write is guaranteed to 403 and replay.
    """
    await _login(naive_client, "csrfcold")

    me = await naive_client.get("/v1/auth/me")
    assert me.status_code == 200
    minted = me.headers[CSRF_HEADER]

    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "cold-start"},
        headers={CSRF_HEADER: minted},
    )
    assert r.status_code == 201


async def test_me_hands_a_pure_bearer_caller_no_token(naive_client):
    """A bearer client (mobile, the desktop main-process outbox) holds no access
    cookie, so it is never CSRF-checked — handing it this long-lived token would only
    have it carrying a secret it has no use for."""
    body = {"username": "csrfbearerme", "password": _PW}
    await naive_client.post("/v1/auth/register", json=body)
    r = await naive_client.post(
        "/v1/auth/token", json=body, headers=client_platform_headers("mobile")
    )
    assert r.status_code == 200, r.text
    assert "access_token" not in set(naive_client.cookies.keys())

    me = await naive_client.get(
        "/v1/auth/me",
        headers={"Authorization": f"Bearer {r.json()['access_token']}"},
    )
    assert me.status_code == 200
    assert CSRF_HEADER not in me.headers


async def test_refresh_rearms_the_session(naive_client):
    """Renewal is the second issuing moment: a rotated session must not be left
    holding a token bound to nothing it can still prove."""
    await _login(naive_client, "csrfrenew")

    refreshed = await naive_client.post("/v1/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    rotated = refreshed.headers.get(CSRF_HEADER)
    assert rotated and rotated.startswith("v1.")

    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "renewed"},
        headers={CSRF_HEADER: rotated},
    )
    assert r.status_code == 201


async def test_mutating_request_without_token_is_rejected(naive_client):
    await _login(naive_client, "csrfnone")
    r = await naive_client.post("/v1/conversations", json={"title": "nope"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED
    # The rejection re-arms the client: retrying with the token it just handed back
    # succeeds without a re-login.
    retry = await naive_client.post(
        "/v1/conversations",
        json={"title": "recovered"},
        headers={CSRF_HEADER: r.headers[CSRF_HEADER]},
    )
    assert retry.status_code == 201


async def test_expired_token_is_rejected(naive_client):
    user_id = await register_and_login(naive_client, "csrfexpired")
    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "stale"},
        headers={CSRF_HEADER: sign_csrf_token(user_id, ttl_seconds=-60)},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED


async def test_token_from_another_session_is_rejected(naive_client, new_client):
    """Tokens are bound to a user_id, so one live session's token cannot drive
    another's — the signature is recomputed against the access cookie's subject."""
    async with new_client() as other:
        other_id = await register_and_login(other, "csrfother")
    await register_and_login(naive_client, "csrfvictim")

    r = await naive_client.post(
        "/v1/conversations",
        json={"title": "cross-user"},
        headers={CSRF_HEADER: sign_csrf_token(other_id)},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED


async def test_logout_is_not_exempt(naive_client):
    """Logout mutates session state, so it stays inside the protected surface: no
    exemption prefix was added to make a token-less client's logout work."""
    csrf = await _login(naive_client, "csrflogout")
    denied = await naive_client.post("/v1/auth/logout")
    assert denied.status_code == 403
    allowed = await naive_client.post("/v1/auth/logout", headers={CSRF_HEADER: csrf})
    assert allowed.status_code == 200


async def test_token_is_never_delivered_as_a_cookie(naive_client):
    """The token rides the CORS-exposed response header only. A non-httpOnly cookie
    had no reader (the backend never read it; a cross-origin SPA cannot see it) and
    was dropped."""
    csrf = await _login(naive_client, "csrfcookie")
    jar = set(naive_client.cookies.keys())
    assert {"access_token", "refresh_token"} <= jar
    assert "csrf_token" not in jar

    # The login header is the whole delivery channel, and it is enough.
    assert (
        await naive_client.post(
            "/v1/conversations", json={"title": "header-only"}, headers={CSRF_HEADER: csrf}
        )
    ).status_code == 201


async def test_echoing_client_needs_no_special_handling(client):
    """A client that keeps the token it was handed at login and echoes it on writes
    (what the desktop and admin consoles do) never sees a 403 for the life of the
    session — no per-response re-arming needed."""
    await register_and_login(client, "csrfecho")
    conv = await client.post("/v1/conversations", json={"title": "one"})
    assert conv.status_code == 201
    assert (
        await client.patch(
            f"/v1/conversations/{conv.json()['id']}", json={"title": "two"}
        )
    ).status_code == 200
    assert (await client.post("/v1/auth/logout")).status_code == 200
