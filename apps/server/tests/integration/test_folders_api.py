"""Integration tests for folder CRUD + conversation grouping (前端UX目标态 §七).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate, the grouped sidebar payload, move-in/move-out, the
delete-keeps-conversations contract, and IDOR isolation between users.
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


async def _new_conversation(client: httpx.AsyncClient, title: str) -> str:
    r = await client.post("/v1/conversations", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_folders_require_auth(client):
    assert (await client.get("/v1/folders")).status_code == 401
    assert (await client.get("/v1/conversations/grouped")).status_code == 401


async def test_create_and_list_folders(client, make_invite):
    code = await make_invite("INV-F1")
    await _register_and_login(client, code, "folderuser1")

    r = await client.post(
        "/v1/folders", json={"name": "Work", "local_dir": "/tmp/work"}
    )
    assert r.status_code == 201, r.text
    folder = r.json()
    assert folder["name"] == "Work"
    assert folder["local_dir"] == "/tmp/work"
    assert folder["id"]

    r = await client.get("/v1/folders")
    assert r.status_code == 200, r.text
    assert [f["id"] for f in r.json()] == [folder["id"]]


async def test_grouped_reflects_membership(client, make_invite):
    code = await make_invite("INV-F2")
    await _register_and_login(client, code, "folderuser2")

    folder_id = (await client.post("/v1/folders", json={"name": "Proj"})).json()["id"]
    grouped_conv = await _new_conversation(client, "in folder")
    loose_conv = await _new_conversation(client, "loose")

    # Initially both conversations are ungrouped.
    body = (await client.get("/v1/conversations/grouped")).json()
    assert {c["id"] for c in body["ungrouped"]} == {grouped_conv, loose_conv}
    assert body["folders"][0]["conversations"] == []

    # Move one into the folder.
    r = await client.patch(
        f"/v1/conversations/{grouped_conv}/folder", json={"folder_id": folder_id}
    )
    assert r.status_code == 200, r.text
    assert r.json()["folder_id"] == folder_id

    body = (await client.get("/v1/conversations/grouped")).json()
    group = body["folders"][0]
    assert [c["id"] for c in group["conversations"]] == [grouped_conv]
    assert [c["id"] for c in body["ungrouped"]] == [loose_conv]

    # Move it back out.
    r = await client.patch(
        f"/v1/conversations/{grouped_conv}/folder", json={"folder_id": None}
    )
    assert r.status_code == 200, r.text
    body = (await client.get("/v1/conversations/grouped")).json()
    assert body["folders"][0]["conversations"] == []
    assert {c["id"] for c in body["ungrouped"]} == {grouped_conv, loose_conv}


async def test_move_to_missing_folder_404(client, make_invite):
    code = await make_invite("INV-F3")
    await _register_and_login(client, code, "folderuser3")
    conv = await _new_conversation(client, "c")

    r = await client.patch(
        f"/v1/conversations/{conv}/folder",
        json={"folder_id": "00000000-0000-0000-0000-000000000000"},
    )
    assert r.status_code == 404, r.text


async def test_update_folder_clears_local_dir(client, make_invite):
    code = await make_invite("INV-F4")
    await _register_and_login(client, code, "folderuser4")
    folder_id = (
        await client.post("/v1/folders", json={"name": "A", "local_dir": "/d"})
    ).json()["id"]

    # Rename without touching local_dir (omitted field is preserved).
    r = await client.patch(f"/v1/folders/{folder_id}", json={"name": "B"})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "B"
    assert r.json()["local_dir"] == "/d"

    # Explicit null clears the binding.
    r = await client.patch(f"/v1/folders/{folder_id}", json={"local_dir": None})
    assert r.status_code == 200, r.text
    assert r.json()["local_dir"] is None
    assert r.json()["name"] == "B"


async def test_delete_folder_keeps_conversations(client, make_invite):
    code = await make_invite("INV-F5")
    await _register_and_login(client, code, "folderuser5")
    folder_id = (await client.post("/v1/folders", json={"name": "Temp"})).json()["id"]
    conv = await _new_conversation(client, "keep me")
    await client.patch(
        f"/v1/conversations/{conv}/folder", json={"folder_id": folder_id}
    )

    r = await client.delete(f"/v1/folders/{folder_id}")
    assert r.status_code == 200, r.text

    body = (await client.get("/v1/conversations/grouped")).json()
    assert body["folders"] == []
    # Conversation survives the folder deletion, falling back to ungrouped.
    assert [c["id"] for c in body["ungrouped"]] == [conv]


async def test_folder_isolation_between_users(client, make_invite, new_client):
    code1 = await make_invite("INV-F6A")
    await _register_and_login(client, code1, "owneruser")
    folder_id = (await client.post("/v1/folders", json={"name": "Mine"})).json()["id"]

    code2 = await make_invite("INV-F6B")
    async with new_client() as other:
        await _register_and_login(other, code2, "intruder")

        # Intruder can't see, edit, or delete someone else's folder.
        assert (await other.get("/v1/folders")).json() == []
        assert (
            await other.patch(f"/v1/folders/{folder_id}", json={"name": "x"})
        ).status_code == 404
        assert (
            await other.delete(f"/v1/folders/{folder_id}")
        ).status_code == 404

        # Nor can they file a conversation into it.
        intruder_conv = await _new_conversation(other, "theirs")
        r = await other.patch(
            f"/v1/conversations/{intruder_conv}/folder",
            json={"folder_id": folder_id},
        )
        assert r.status_code == 404, r.text

    # Owner's folder is untouched.
    assert (await client.get("/v1/folders")).json()[0]["id"] == folder_id
