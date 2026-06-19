"""End-to-end API integration tests for GET /v1/capabilities (能力图鉴).

Covers auth gating + the complete shape: the full tool catalog (CEO orchestration +
worker mutation, annotated with reach), the system Skills (summary + body), and the CEO
system-prompt template — the data the desktop 能力图鉴 renders.
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


async def test_capabilities_requires_auth(client):
    assert (await client.get("/v1/capabilities")).status_code == 401


async def test_capabilities_returns_full_catalog(client, make_invite):
    code = await make_invite("INV-CAP-1")
    await _register_and_login(client, code, "capuser")

    r = await client.get("/v1/capabilities")
    assert r.status_code == 200, r.text
    body = r.json()

    tools = {t["name"]: t for t in body["tools"]}
    # The complete repertoire — CEO orchestration the old /v1/tools never served…
    for name in ("delegate", "revise", "consult_skill", "ask_user"):
        assert name in tools
        assert tools[name]["available_to"] == ["ceo"]
    # …worker-only mutation + escalate…
    for name in ("file_write", "code_execute", "escalate"):
        assert name in tools
        assert tools[name]["available_to"] == ["worker"]
    # …and shared read/retrieval built-ins.
    assert set(tools["web_search"]["available_to"]) == {"ceo", "worker"}
    # Each tool carries its call JSON Schema (用法教学).
    assert tools["web_search"]["parameters"]["type"] == "object"


async def test_capabilities_lists_system_skills_with_body(client, make_invite):
    code = await make_invite("INV-CAP-2")
    await _register_and_login(client, code, "skilluser")

    body = (await client.get("/v1/capabilities")).json()
    skills = {s["name"]: s for s in body["skills"]}
    assert "team_orchestration_advanced" in skills
    assert "asking_the_user" in skills
    for skill in skills.values():
        assert skill["summary"]
        assert skill["body"]  # the full guidance, not just the catalog one-liner


async def test_capabilities_exposes_prompt_template(client, make_invite):
    code = await make_invite("INV-CAP-3")
    await _register_and_login(client, code, "promptuser")

    guidelines = (await client.get("/v1/capabilities")).json()["guidelines"]
    assert guidelines["shared_base"]
    ceo = guidelines["ceo"]
    # The CEO template carries the routing core + the always-on 能力目录.
    assert "CEO" in ceo
    assert "能力目录" in ceo
    # The shared base is a prefix of the CEO prompt (it layers hints onto the base).
    assert ceo.startswith(guidelines["shared_base"])
