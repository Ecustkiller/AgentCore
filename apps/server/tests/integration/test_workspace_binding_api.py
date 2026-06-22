"""Integration tests for local-mode workspace binding (双模式工作区 §七 / P2d).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate, the cloud→local→cloud lifecycle (文件夹即工作区: a binding lives
on the folder; binding a 裸聊 lazily promotes it into a folder first; a foldered chat
binds its shared folder so siblings flip too), the derived mode surfaced on reads,
validation, and IDOR isolation.
"""

import httpx

_PW = "password123"
_ROOT = "11111111-2222-3333-4444-555555555555"


async def _register_and_login(client: httpx.AsyncClient, invite_code: str, username: str) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text


async def _new_conversation(client: httpx.AsyncClient, title: str) -> str:
    r = await client.post("/v1/conversations", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_binding_requires_auth(client):
    cid = "00000000-0000-0000-0000-000000000000"
    assert (await client.get(f"/v1/conversations/{cid}/workspace/binding")).status_code == 401
    assert (
        await client.put(f"/v1/conversations/{cid}/workspace/binding", json={"root_id": _ROOT})
    ).status_code == 401
    assert (await client.delete(f"/v1/conversations/{cid}/workspace/binding")).status_code == 401


async def test_bind_promotes_bare_chat_to_folder(client, make_invite):
    code = await make_invite("INV-B1")
    await _register_and_login(client, code, "binduser1")
    conv = await _new_conversation(client, "solo")

    # A 裸聊 defaults to cloud, conversation-scoped (no folder/workspace yet).
    r = await client.get(f"/v1/conversations/{conv}/workspace/binding")
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "cloud", "scope": "conversation", "root_id": None}

    # Binding a 裸聊 lazily mints a folder workspace and files the chat into it
    # (文件夹即工作区 §懒建): the binding is folder-scoped from now on.
    r = await client.put(f"/v1/conversations/{conv}/workspace/binding", json={"root_id": _ROOT})
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "local", "scope": "folder", "root_id": _ROOT}

    # The chat is now in a folder (promoted) and durably local.
    detail = (await client.get(f"/v1/conversations/{conv}")).json()
    assert detail["folder_id"] is not None
    assert (await client.get(f"/v1/conversations/{conv}/workspace/binding")).json()[
        "mode"
    ] == "local"

    # Unbind → the folder (and so the chat) returns to cloud.
    r = await client.delete(f"/v1/conversations/{conv}/workspace/binding")
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "cloud", "scope": "folder", "root_id": None}


async def test_bind_foldered_conversation_is_shared_by_siblings(client, make_invite):
    code = await make_invite("INV-B2")
    await _register_and_login(client, code, "binduser2")
    folder_id = (await client.post("/v1/folders", json={"name": "Proj"})).json()["id"]
    conv_a = await _new_conversation(client, "a")
    conv_b = await _new_conversation(client, "b")
    for cid in (conv_a, conv_b):
        await client.patch(f"/v1/conversations/{cid}/folder", json={"folder_id": folder_id})

    # Binding through one conversation writes at the *folder* scope.
    r = await client.put(f"/v1/conversations/{conv_a}/workspace/binding", json={"root_id": _ROOT})
    assert r.status_code == 200, r.text
    assert r.json() == {"mode": "local", "scope": "folder", "root_id": _ROOT}

    # Its sibling sees local mode too (the folder is the shared project space).
    r = await client.get(f"/v1/conversations/{conv_b}/workspace/binding")
    assert r.json() == {"mode": "local", "scope": "folder", "root_id": _ROOT}

    # The grouped sidebar carries the folder's binding for the mode badge.
    grouped = (await client.get("/v1/conversations/grouped")).json()
    assert grouped["folders"][0]["local_root_id"] == _ROOT

    # Unbinding through the *other* conversation clears it for the whole folder.
    r = await client.delete(f"/v1/conversations/{conv_b}/workspace/binding")
    assert r.json() == {"mode": "cloud", "scope": "folder", "root_id": None}
    assert (await client.get(f"/v1/conversations/{conv_a}/workspace/binding")).json()[
        "mode"
    ] == "cloud"


async def test_bind_rejects_empty_root_id(client, make_invite):
    code = await make_invite("INV-B3")
    await _register_and_login(client, code, "binduser3")
    conv = await _new_conversation(client, "c")
    r = await client.put(f"/v1/conversations/{conv}/workspace/binding", json={"root_id": ""})
    assert r.status_code == 422, r.text


async def test_binding_isolation_between_users(client, make_invite, new_client):
    code1 = await make_invite("INV-B4A")
    await _register_and_login(client, code1, "bindowner")
    conv = await _new_conversation(client, "mine")

    code2 = await make_invite("INV-B4B")
    async with new_client() as other:
        await _register_and_login(other, code2, "bindintruder")
        # A non-owner can neither read nor change the binding (404, IDOR-safe).
        assert (await other.get(f"/v1/conversations/{conv}/workspace/binding")).status_code == 404
        assert (
            await other.put(f"/v1/conversations/{conv}/workspace/binding", json={"root_id": _ROOT})
        ).status_code == 404
        assert (
            await other.delete(f"/v1/conversations/{conv}/workspace/binding")
        ).status_code == 404

    # The owner's conversation stayed on cloud.
    assert (await client.get(f"/v1/conversations/{conv}/workspace/binding")).json()[
        "mode"
    ] == "cloud"
