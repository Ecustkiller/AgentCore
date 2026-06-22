"""Integration test for the read-only built-in tool catalog endpoint.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate and the response shape the toolbox UI consumes.
"""

import httpx

_PW = "password123"


async def _register_and_login(client: httpx.AsyncClient, invite_code: str, username: str) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text


async def test_tools_requires_auth(client):
    assert (await client.get("/v1/tools")).status_code == 401


async def test_tools_lists_builtin_catalog(client, make_invite):
    code = await make_invite("INV-TOOLS")
    await _register_and_login(client, code, "toolsuser")

    r = await client.get("/v1/tools")
    assert r.status_code == 200, r.text
    body = r.json()

    assert body["total"] == len(body["data"]) == 10
    names = {t["name"] for t in body["data"]}
    assert {"web_search", "file_write", "grep", "file_delete", "file_move"} <= names
    # The CEO-only orchestration primitive is never advertised in the catalog.
    assert "delegate" not in names

    # Governance + schema fields the UI renders are present and correctly typed.
    fw = next(t for t in body["data"] if t["name"] == "file_write")
    assert fw["approval"] == "grantable"
    assert fw["category"] == "filesystem"
    assert isinstance(fw["parameters"], dict)
