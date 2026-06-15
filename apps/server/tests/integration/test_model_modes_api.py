"""Integration tests for the 质量档 (model-mode) API — user-selectable team-language
model config (api/routes/model_modes.py + conversation/account integration).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate, presets + catalog, custom-mode CRUD with operator-ceiling
validation, account-default selection (incl. /auth/me echo), per-conversation
override on create + patch, and IDOR isolation between users.
"""

import httpx

from agentcore.llm.config import DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO

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


async def _make_mode(
    client: httpx.AsyncClient, name: str, assignments: dict
) -> dict:
    r = await client.post(
        "/v1/model-modes", json={"name": name, "assignments": assignments}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_model_modes_require_auth(client):
    assert (await client.get("/v1/model-modes")).status_code == 401
    assert (await client.get("/v1/model-modes/catalog")).status_code == 401
    assert (
        await client.post("/v1/model-modes", json={"name": "x", "assignments": {}})
    ).status_code == 401


async def test_list_presets_and_operator_default(client, make_invite):
    code = await make_invite("INV-MM1")
    await _register_and_login(client, code, "mmuser1")

    body = (await client.get("/v1/model-modes")).json()
    presets = {p["key"]: p["assignments"] for p in body["presets"]}
    # Built-in presets are always present and read-only.
    assert presets["economy"] == {}
    assert presets["quality"] == {
        "ceo": DEEPSEEK_V4_PRO,
        "worker_strong": DEEPSEEK_V4_PRO,
    }
    # No custom modes yet; default falls back to the operator default ("economy").
    assert body["custom"] == []
    assert body["default_mode"] == "economy"


async def test_catalog_marks_economy_worker_locked(client, make_invite):
    code = await make_invite("INV-MM2")
    await _register_and_login(client, code, "mmuser2")

    body = (await client.get("/v1/model-modes/catalog")).json()
    roles = {r["role"]: r for r in body["roles"]}
    assert roles["ceo"]["configurable"] is True
    assert roles["ceo"]["locked_model"] is None
    assert roles["worker_strong"]["configurable"] is True
    # 经济worker is locked to its base (Flash) — shown read-only.
    assert roles["worker_economy"]["configurable"] is False
    assert roles["worker_economy"]["locked_model"] == DEEPSEEK_V4_FLASH
    # Models offered = operator ceiling, sorted.
    assert body["models"] == sorted([DEEPSEEK_V4_FLASH, DEEPSEEK_V4_PRO])


async def test_create_and_list_custom_mode(client, make_invite):
    code = await make_invite("INV-MM3")
    await _register_and_login(client, code, "mmuser3")

    mode = await _make_mode(client, "我的高配", {"ceo": DEEPSEEK_V4_PRO})
    assert mode["name"] == "我的高配"
    assert mode["assignments"] == {"ceo": DEEPSEEK_V4_PRO}
    assert mode["id"]

    body = (await client.get("/v1/model-modes")).json()
    assert [m["id"] for m in body["custom"]] == [mode["id"]]


async def test_create_rejects_forbidden_model(client, make_invite):
    code = await make_invite("INV-MM4")
    await _register_and_login(client, code, "mmuser4")
    r = await client.post(
        "/v1/model-modes",
        json={"name": "bad", "assignments": {"ceo": "deepseek-v9-imaginary"}},
    )
    assert r.status_code == 422, r.text


async def test_create_rejects_locked_role(client, make_invite):
    code = await make_invite("INV-MM5")
    await _register_and_login(client, code, "mmuser5")
    # 经济worker is not configurable → assigning it any model is rejected.
    r = await client.post(
        "/v1/model-modes",
        json={"name": "bad", "assignments": {"worker_economy": DEEPSEEK_V4_PRO}},
    )
    assert r.status_code == 422, r.text


async def test_update_custom_mode_partial(client, make_invite):
    code = await make_invite("INV-MM6")
    await _register_and_login(client, code, "mmuser6")
    mode = await _make_mode(
        client, "orig", {"ceo": DEEPSEEK_V4_PRO, "worker_strong": DEEPSEEK_V4_PRO}
    )

    # Rename only — assignments preserved (omitted field untouched).
    r = await client.patch(
        f"/v1/model-modes/{mode['id']}", json={"name": "renamed"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "renamed"
    assert r.json()["assignments"] == {
        "ceo": DEEPSEEK_V4_PRO,
        "worker_strong": DEEPSEEK_V4_PRO,
    }

    # Replace assignments.
    r = await client.patch(
        f"/v1/model-modes/{mode['id']}",
        json={"assignments": {"ceo": DEEPSEEK_V4_FLASH}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["assignments"] == {"ceo": DEEPSEEK_V4_FLASH}

    # An invalid update is rejected and changes nothing.
    r = await client.patch(
        f"/v1/model-modes/{mode['id']}",
        json={"assignments": {"worker_economy": DEEPSEEK_V4_PRO}},
    )
    assert r.status_code == 422, r.text


async def test_update_missing_mode_404(client, make_invite):
    code = await make_invite("INV-MM7")
    await _register_and_login(client, code, "mmuser7")
    r = await client.patch(
        "/v1/model-modes/00000000-0000-0000-0000-000000000000",
        json={"name": "x"},
    )
    assert r.status_code == 404, r.text


async def test_delete_custom_mode(client, make_invite):
    code = await make_invite("INV-MM8")
    await _register_and_login(client, code, "mmuser8")
    mode = await _make_mode(client, "temp", {"ceo": DEEPSEEK_V4_PRO})

    r = await client.delete(f"/v1/model-modes/{mode['id']}")
    assert r.status_code == 200, r.text
    assert (await client.get("/v1/model-modes")).json()["custom"] == []

    # Second delete is a 404 (already gone).
    assert (
        await client.delete(f"/v1/model-modes/{mode['id']}")
    ).status_code == 404


async def test_set_account_default_to_custom_mode(client, make_invite):
    code = await make_invite("INV-MM9")
    await _register_and_login(client, code, "mmuser9")
    mode = await _make_mode(client, "默认高配", {"ceo": DEEPSEEK_V4_PRO})

    r = await client.put("/v1/model-modes/default", json={"mode": mode["id"]})
    assert r.status_code == 200, r.text

    # Surfaced both in the modes payload and on /auth/me.
    assert (await client.get("/v1/model-modes")).json()["default_mode"] == mode["id"]
    assert (await client.get("/v1/auth/me")).json()["default_model_mode"] == mode["id"]

    # Clearing it (null) falls back to the operator default.
    r = await client.put("/v1/model-modes/default", json={"mode": None})
    assert r.status_code == 200, r.text
    assert (await client.get("/v1/model-modes")).json()["default_mode"] == "economy"
    assert (await client.get("/v1/auth/me")).json()["default_model_mode"] is None


async def test_set_default_to_preset_and_unknown(client, make_invite):
    code = await make_invite("INV-MM10")
    await _register_and_login(client, code, "mmuser10")

    # A built-in preset key is a valid default.
    assert (
        await client.put("/v1/model-modes/default", json={"mode": "quality"})
    ).status_code == 200
    assert (await client.get("/v1/model-modes")).json()["default_mode"] == "quality"

    # An unknown ref is rejected.
    r = await client.put("/v1/model-modes/default", json={"mode": "ghost-mode"})
    assert r.status_code == 422, r.text


async def test_conversation_mode_override_on_create(client, make_invite):
    code = await make_invite("INV-MM11")
    await _register_and_login(client, code, "mmuser11")
    mode = await _make_mode(client, "conv高配", {"ceo": DEEPSEEK_V4_PRO})

    # Create pinned to a preset.
    r = await client.post(
        "/v1/conversations", json={"title": "q", "model_mode": "quality"}
    )
    assert r.status_code == 201, r.text
    assert r.json()["model_mode"] == "quality"

    # Create pinned to an owned custom mode.
    r = await client.post(
        "/v1/conversations", json={"title": "c", "model_mode": mode["id"]}
    )
    assert r.status_code == 201, r.text
    assert r.json()["model_mode"] == mode["id"]

    # Create with an unknown mode is rejected.
    r = await client.post(
        "/v1/conversations", json={"title": "bad", "model_mode": "ghost"}
    )
    assert r.status_code == 422, r.text


async def test_conversation_mode_patch(client, make_invite):
    code = await make_invite("INV-MM12")
    await _register_and_login(client, code, "mmuser12")
    conv_id = (
        await client.post("/v1/conversations", json={"title": "c"})
    ).json()["id"]

    # Pin a mode.
    r = await client.patch(
        f"/v1/conversations/{conv_id}", json={"model_mode": "quality"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_mode"] == "quality"

    # Clear it back to inherit.
    r = await client.patch(
        f"/v1/conversations/{conv_id}", json={"model_mode": None}
    )
    assert r.status_code == 200, r.text
    assert r.json()["model_mode"] is None

    # Unknown mode rejected.
    r = await client.patch(
        f"/v1/conversations/{conv_id}", json={"model_mode": "ghost"}
    )
    assert r.status_code == 422, r.text


async def test_custom_mode_isolation_between_users(client, make_invite, new_client):
    code1 = await make_invite("INV-MM13A")
    await _register_and_login(client, code1, "mmowner")
    mode = await _make_mode(client, "私有", {"ceo": DEEPSEEK_V4_PRO})

    code2 = await make_invite("INV-MM13B")
    async with new_client() as other:
        await _register_and_login(other, code2, "mmintruder")

        # Intruder can't see, edit, or delete someone else's custom mode.
        assert (await other.get("/v1/model-modes")).json()["custom"] == []
        assert (
            await other.patch(
                f"/v1/model-modes/{mode['id']}", json={"name": "x"}
            )
        ).status_code == 404
        assert (
            await other.delete(f"/v1/model-modes/{mode['id']}")
        ).status_code == 404

        # Nor set it as their default (resolves to "unknown" for them).
        assert (
            await other.put("/v1/model-modes/default", json={"mode": mode["id"]})
        ).status_code == 422

        # Nor pin a conversation to it.
        r = await other.post(
            "/v1/conversations", json={"title": "x", "model_mode": mode["id"]}
        )
        assert r.status_code == 422, r.text

    # Owner's mode is untouched.
    assert (await client.get("/v1/model-modes")).json()["custom"][0]["id"] == mode["id"]
