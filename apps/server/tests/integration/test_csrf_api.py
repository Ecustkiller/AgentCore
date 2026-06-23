"""Integration: CSRF synchronizer token on cookie login flow."""

import pytest

from agentcore.middleware.csrf import CSRF_HEADER

_PW = "password123"


@pytest.mark.csrf
async def test_login_issues_csrf_and_allows_mutating_request(client, make_invite):
    code = await make_invite("INV-CSRF-INT")
    await client.post(
        "/v1/auth/register",
        json={"username": "csrfint", "password": _PW, "invite_code": code},
    )
    login = await client.post(
        "/v1/auth/login",
        json={"username": "csrfint", "password": _PW},
    )
    assert login.status_code == 200
    csrf = login.headers.get(CSRF_HEADER)
    assert csrf

    r = await client.post(
        "/v1/conversations",
        json={"title": "csrf-ok"},
        headers={CSRF_HEADER: csrf},
    )
    assert r.status_code == 201
