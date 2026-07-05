"""Integration test for the read-only built-in tool catalog endpoint.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate and the response shape the toolbox UI consumes.
"""

from agentcore.tools.builtin import build_builtin_registry
from tests.integration.conftest import register_and_login


async def test_tools_requires_auth(client):
    assert (await client.get("/v1/tools")).status_code == 401


async def test_tools_lists_builtin_catalog(client, make_invite):
    code = await make_invite("INV-TOOLS")
    await register_and_login(client, code, "toolsuser")

    r = await client.get("/v1/tools")
    assert r.status_code == 200, r.text
    body = r.json()

    expected = {schema.name for schema in build_builtin_registry().list_all()}
    assert body["total"] == len(body["data"]) == len(expected)
    names = {t["name"] for t in body["data"]}
    assert names == expected
    # The CEO-only orchestration primitive is never advertised in the catalog.
    assert "delegate" not in names

    # Governance + schema fields the UI renders are present and correctly typed.
    fw = next(t for t in body["data"] if t["name"] == "file_write")
    assert fw["approval"] == "grantable"
    assert fw["category"] == "filesystem"
    assert isinstance(fw["parameters"], dict)
