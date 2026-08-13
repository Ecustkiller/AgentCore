"""CSRF middleware tests (stateless HMAC-signed token, cookie-session clients)."""

import pytest
from httpx import ASGITransport, AsyncClient
from starlette.requests import Request
from starlette.responses import Response

from agentcore.api.dependencies import ACCESS_TOKEN_COOKIE
from agentcore.config import settings
from agentcore.core.error_codes import ErrorCode
from agentcore.core.types import new_id
from agentcore.main import app
from agentcore.middleware.csrf import (
    CSRF_HEADER,
    issue_csrf_token,
    issue_csrf_token_for_cookie_session,
)
from agentcore.security import (
    CsrfRejectReason,
    create_access_token,
    csrf_reject_reason,
    sign_csrf_token,
    verify_csrf_token,
)
from tests.conftest import LogSpy


@pytest.fixture
def csrf_enabled(monkeypatch):
    monkeypatch.setattr(settings, "csrf_enabled", True)


@pytest.fixture
def csrf_log(monkeypatch) -> LogSpy:
    """Capture ``security.csrf_rejected`` so the rejection's attribution fields
    (reason / user_id) are asserted, not just the 403."""
    spy = LogSpy()
    monkeypatch.setattr("agentcore.middleware.csrf.logger", spy)
    return spy


@pytest.mark.asyncio
async def test_csrf_blocks_mutating_request_without_header(csrf_enabled, csrf_log):
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post("/v1/conversations", json={"title": "nope"})
        assert r.status_code == 403
        assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED

    rejected = csrf_log.get("security.csrf_rejected")
    assert rejected["reason"] == CsrfRejectReason.MISSING
    assert rejected["user_id"] == user_id
    assert rejected["path"] == "/v1/conversations"
    assert rejected["method"] == "POST"


@pytest.mark.asyncio
async def test_csrf_allows_mutating_request_with_valid_header(csrf_enabled):
    user_id = new_id()
    token = create_access_token(user_id, audience="product")
    csrf = sign_csrf_token(user_id)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        # Auth will 401 (no DB user) — CSRF must pass first; we only assert not 403.
        r = await client.post(
            "/v1/conversations",
            json={"title": "ok"},
            headers={CSRF_HEADER: csrf},
        )
        assert r.status_code != 403


@pytest.mark.asyncio
async def test_csrf_rejects_token_minted_for_another_user(csrf_enabled, csrf_log):
    """A signed token is bound to its user_id; presenting it under a different
    session's access cookie must fail (stateless binding, not just any valid sig)."""
    user_id = new_id()
    other_id = new_id()
    token = create_access_token(user_id, audience="product")
    foreign_csrf = sign_csrf_token(other_id)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "nope"},
            headers={CSRF_HEADER: foreign_csrf},
        )
        assert r.status_code == 403
        assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED

    # Cross-user reuse is the *signature* failing, not a structural or expiry
    # problem — the production logs must be able to tell those apart.
    rejected = csrf_log.get("security.csrf_rejected")
    assert rejected["reason"] == CsrfRejectReason.SIGNATURE_MISMATCH
    assert rejected["user_id"] == user_id


@pytest.mark.asyncio
async def test_csrf_rejects_expired_token(csrf_enabled, csrf_log):
    """An aged-out token is reported as expired, distinctly from a forged one."""
    user_id = new_id()
    token = create_access_token(user_id, audience="product")
    stale = sign_csrf_token(user_id, ttl_seconds=-60)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "nope"},
            headers={CSRF_HEADER: stale},
        )
        assert r.status_code == 403

    assert csrf_log.get("security.csrf_rejected")["reason"] == CsrfRejectReason.EXPIRED


@pytest.mark.asyncio
async def test_csrf_rejects_malformed_token(csrf_enabled, csrf_log):
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "nope"},
            headers={CSRF_HEADER: "garbage"},
        )
        assert r.status_code == 403

    assert csrf_log.get("security.csrf_rejected")["reason"] == CsrfRejectReason.MALFORMED


@pytest.mark.asyncio
async def test_csrf_enforced_when_cookie_present_despite_bearer_header(csrf_enabled):
    """SEC-003: a session-cookie request must still pass CSRF even if it also carries
    an Authorization header. The auth layer prefers the cookie, so a bogus bearer must
    not let a cross-site request skip CSRF (which would collapse protection onto CORS)."""
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "nope"},
            headers={"Authorization": "Bearer anything"},
        )
        assert r.status_code == 403
        assert r.json()["error"]["code"] == ErrorCode.CSRF_FAILED


@pytest.mark.asyncio
async def test_csrf_exempt_for_pure_bearer_client_without_cookie(csrf_enabled):
    """A genuine bearer client (mobile) sends no session cookie, so CSRF does not
    apply — it is not 403'd for a missing CSRF header (downstream auth handles it)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post(
            "/v1/conversations",
            json={"title": "ok"},
            headers={"Authorization": "Bearer anything"},
        )
        assert r.status_code != 403


# --- Where the token comes from (login / refresh / /me / the 403 that rejects) -------


@pytest.mark.asyncio
async def test_reads_hand_out_no_token(csrf_enabled):
    """An ordinary GET on a live cookie session must not carry one.

    The token lives as long as the refresh window and cannot be revoked, so stamping
    it on every response would smear it across proxy access logs, exported network
    traces and error-report breadcrumbs for no gain — the client is supplied at a
    handshake (``/v1/auth/me`` included) and re-armed by the 403 if it ever turns up
    empty-handed.
    """
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.get("/v1/conversations")
        assert CSRF_HEADER not in r.headers


@pytest.mark.asyncio
async def test_accepted_mutating_request_hands_out_no_token(csrf_enabled):
    """Nor does a write that passed the check: the token it presented still works."""
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "ok"},
            headers={CSRF_HEADER: sign_csrf_token(user_id)},
        )
        assert r.status_code != 403
        assert CSRF_HEADER not in r.headers


@pytest.mark.asyncio
async def test_rejection_response_carries_a_fresh_token(csrf_enabled):
    """A client that simply never had a token is re-armed by the 403 itself, so the
    fault costs one retry rather than a re-login — which is what the desktop and
    admin consoles tell the user to do."""
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post("/v1/conversations", json={"title": "nope"})
        assert r.status_code == 403
        assert verify_csrf_token(user_id, r.headers[CSRF_HEADER])


@pytest.mark.asyncio
async def test_signature_mismatch_rejection_withholds_a_fresh_token(csrf_enabled):
    """A token minted for another session must NOT be re-armed.

    Two browser apps pointed at one API origin share a cookie jar, so a mismatch can
    mean this session was taken over by another account. Re-arming would bind the
    client to whoever owns the cookie now, and the user's natural retry would then
    succeed *as that other account* — a silent wrong-account write in place of a
    loud failure.
    """
    user_id = new_id()
    token = create_access_token(user_id, audience="product")
    foreign_csrf = sign_csrf_token(new_id())

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post(
            "/v1/conversations",
            json={"title": "nope"},
            headers={CSRF_HEADER: foreign_csrf},
        )
        assert r.status_code == 403
        assert CSRF_HEADER not in r.headers


@pytest.mark.asyncio
async def test_no_token_for_a_request_with_no_decodable_session(csrf_enabled):
    """The token is bound to a user_id; a request with no (valid) access cookie has
    none to bind to, so it is neither checked nor armed (downstream auth 401s it)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/v1/conversations", json={"title": "anon"})
        assert r.status_code != 403
        assert CSRF_HEADER not in r.headers

        client.cookies.set(ACCESS_TOKEN_COOKIE, "not-a-jwt")
        r = await client.post("/v1/conversations", json={"title": "forged"})
        assert r.status_code != 403
        assert CSRF_HEADER not in r.headers


@pytest.mark.asyncio
async def test_disabled_middleware_neither_checks_nor_issues(monkeypatch):
    monkeypatch.setattr(settings, "csrf_enabled", False)
    user_id = new_id()
    token = create_access_token(user_id, audience="product")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client.cookies.set(ACCESS_TOKEN_COOKIE, token)
        r = await client.post("/v1/conversations", json={"title": "unguarded"})
        assert r.status_code != 403
        assert CSRF_HEADER not in r.headers


# --- Token primitives ----------------------------------------------------------------


def test_issue_csrf_token_sets_header_and_is_verifiable():
    resp = Response()
    token = issue_csrf_token(resp, "u1")
    assert resp.headers[CSRF_HEADER] == token
    assert verify_csrf_token("u1", token)
    # Stateless + bound: the same token does not verify for a different user.
    assert not verify_csrf_token("u2", token)


def _request_carrying(access_token: str | None) -> Request:
    """A minimal GET (as ``/v1/auth/me`` arrives) with or without an access cookie."""
    headers: list[tuple[bytes, bytes]] = []
    if access_token:
        headers.append((b"cookie", f"{ACCESS_TOKEN_COOKIE}={access_token}".encode()))
    return Request({"type": "http", "method": "GET", "path": "/v1/auth/me", "headers": headers})


def test_cookie_session_issuance_arms_the_caller(csrf_enabled):
    """What ``/v1/auth/me`` does: a cold start resuming on a live access cookie skips
    login and refresh, so this handshake is its only chance to be armed before the
    first write."""
    user_id = new_id()
    resp = Response()
    token = issue_csrf_token_for_cookie_session(
        _request_carrying(create_access_token(user_id, audience="product")), resp, user_id
    )
    assert token is not None
    assert resp.headers[CSRF_HEADER] == token
    assert verify_csrf_token(user_id, token)


def test_cookie_session_issuance_skips_a_pure_bearer_caller(csrf_enabled):
    """No access cookie means the caller (mobile, the desktop main-process outbox) is
    never CSRF-checked, so arming it would only hand it a refresh-window-lived secret
    to carry around."""
    resp = Response()
    assert issue_csrf_token_for_cookie_session(_request_carrying(None), resp, new_id()) is None
    assert CSRF_HEADER not in resp.headers


def test_cookie_session_issuance_binds_to_the_cookie_not_the_caller(csrf_enabled):
    """Mint for the session that would be *checked*, or not at all: an authenticated
    subject that isn't the access cookie's is never armed, however identity was
    resolved."""
    resp = Response()
    cookie_of_someone_else = create_access_token(new_id(), audience="product")
    assert (
        issue_csrf_token_for_cookie_session(
            _request_carrying(cookie_of_someone_else), resp, new_id()
        )
        is None
    )
    assert CSRF_HEADER not in resp.headers


def test_cookie_session_issuance_is_inert_when_csrf_is_disabled(monkeypatch):
    monkeypatch.setattr(settings, "csrf_enabled", False)
    user_id = new_id()
    resp = Response()
    assert (
        issue_csrf_token_for_cookie_session(
            _request_carrying(create_access_token(user_id, audience="product")), resp, user_id
        )
        is None
    )
    assert CSRF_HEADER not in resp.headers


@pytest.mark.parametrize(
    ("token", "expected"),
    [
        ("", CsrfRejectReason.MISSING),
        ("garbage", CsrfRejectReason.MALFORMED),
        ("v1.nonce.123", CsrfRejectReason.MALFORMED),  # too few segments
        ("v2.nonce.99999999999.sig", CsrfRejectReason.MALFORMED),  # unknown version
        ("v1.nonce.not-a-number.sig", CsrfRejectReason.MALFORMED),
        ("v1.nonce.99999999999.wrong-sig", CsrfRejectReason.SIGNATURE_MISMATCH),
    ],
)
def test_csrf_reject_reason_classifies_bad_tokens(token, expected):
    assert csrf_reject_reason("u1", token) is expected


def test_csrf_reject_reason_separates_expiry_from_forgery():
    # Signature is checked first, so only a token this server really minted for this
    # user can be reported as expired — a forged one can never masquerade as one.
    assert csrf_reject_reason("u1", sign_csrf_token("u1", ttl_seconds=-1)) is (
        CsrfRejectReason.EXPIRED
    )
    assert csrf_reject_reason("u2", sign_csrf_token("u1", ttl_seconds=-1)) is (
        CsrfRejectReason.SIGNATURE_MISMATCH
    )


def test_csrf_reject_reason_accepts_a_live_token():
    assert csrf_reject_reason("u1", sign_csrf_token("u1")) is None


def test_signing_key_follows_a_rotated_jwt_secret(monkeypatch):
    """The derived key is memoised (one HMAC per response, not two) — keyed on the
    secret so rotating it invalidates old tokens instead of serving a stale key."""
    token = sign_csrf_token("u1")
    monkeypatch.setattr(settings, "jwt_secret_key", "a-different-secret-entirely")
    assert csrf_reject_reason("u1", token) is CsrfRejectReason.SIGNATURE_MISMATCH
    assert verify_csrf_token("u1", sign_csrf_token("u1"))
