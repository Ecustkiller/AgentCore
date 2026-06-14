"""Integration tests for the workspace file + snapshot HTTP routes.

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers the auth gate, per-user scoping (IDOR), the raw-body upload / download
round-trip, and the snapshot create → list → restore → download lifecycle.

``data_dir`` and the storage backend are redirected to a tmp dir so the routes
never write under the real ./data tree; the lru-cached storage factory is
cleared around each test so the redirect takes effect.
"""

from pathlib import Path

import httpx
import pytest

from agentcore.config import settings
from agentcore.storage.factory import build_storage_provider

_PW = "password123"


@pytest.fixture
def _fs_data_dir(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(settings, "storage_backend", "filesystem")
    build_storage_provider.cache_clear()
    try:
        yield
    finally:
        build_storage_provider.cache_clear()


async def _register_and_login(
    client: httpx.AsyncClient, invite_code: str, username: str
) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text


async def _new_conversation(client: httpx.AsyncClient) -> str:
    r = await client.post("/v1/conversations", json={})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_workspace_files_requires_auth(client):
    r = await client.get("/v1/conversations/whatever/workspace/files")
    assert r.status_code == 401


async def test_upload_list_download_roundtrip(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WS-1")
    await _register_and_login(client, code, "wsuser1")
    conv_id = await _new_conversation(client)

    body = b"hello-from-upload\x00\x01"  # includes non-text bytes
    r = await client.put(
        f"/v1/conversations/{conv_id}/workspace/files/notes/hello.bin", content=body
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "notes/hello.bin", "size_bytes": len(body)}

    r = await client.get(
        f"/v1/conversations/{conv_id}/workspace/files", params={"recursive": "true"}
    )
    assert r.status_code == 200, r.text
    paths = {e["path"] for e in r.json()["data"]}
    assert "notes/hello.bin" in paths

    r = await client.get(f"/v1/conversations/{conv_id}/workspace/files/notes/hello.bin")
    assert r.status_code == 200
    assert r.content == body
    assert 'filename="hello.bin"' in r.headers.get("content-disposition", "")

    r = await client.get(f"/v1/conversations/{conv_id}/workspace/files/ghost.txt")
    assert r.status_code == 404


async def test_snapshot_create_list_restore_download(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WS-2")
    await _register_and_login(client, code, "wsuser2")
    conv_id = await _new_conversation(client)

    # Seed v1, snapshot it, then overwrite with v2.
    await client.put(
        f"/v1/conversations/{conv_id}/workspace/files/doc.txt", content=b"v1"
    )
    r = await client.post(
        f"/v1/conversations/{conv_id}/snapshots", json={"label": "milestone"}
    )
    assert r.status_code == 201, r.text
    snap = r.json()
    assert snap["label"] == "milestone"
    sid = snap["snapshot_id"]

    r = await client.get(f"/v1/conversations/{conv_id}/snapshots")
    assert r.status_code == 200
    assert sid in {s["snapshot_id"] for s in r.json()["data"]}

    await client.put(
        f"/v1/conversations/{conv_id}/workspace/files/doc.txt", content=b"v2"
    )

    # Restore brings v1 back.
    r = await client.post(f"/v1/conversations/{conv_id}/snapshots/{sid}/restore")
    assert r.status_code == 200, r.text
    r = await client.get(f"/v1/conversations/{conv_id}/workspace/files/doc.txt")
    assert r.content == b"v1"

    # Download the archive (zip bytes).
    r = await client.get(f"/v1/conversations/{conv_id}/snapshots/{sid}/download")
    assert r.status_code == 200
    assert r.content[:2] == b"PK"
    assert r.headers["content-type"] == "application/zip"

    # Unknown snapshot id → 404 on both restore and download.
    assert (
        await client.post(f"/v1/conversations/{conv_id}/snapshots/nope/restore")
    ).status_code == 404
    assert (
        await client.get(f"/v1/conversations/{conv_id}/snapshots/nope/download")
    ).status_code == 404


async def test_other_user_cannot_touch_workspace(
    client, new_client, make_invite, _fs_data_dir
):
    """A conversation's workspace is scoped to its owner (IDOR-safe → 404)."""
    code_a = await make_invite("INV-WS-A")
    await _register_and_login(client, code_a, "owner")
    conv_id = await _new_conversation(client)
    await client.put(
        f"/v1/conversations/{conv_id}/workspace/files/secret.txt", content=b"top"
    )

    code_b = await make_invite("INV-WS-B")
    async with new_client() as other:
        await _register_and_login(other, code_b, "intruder")
        assert (
            await other.get(f"/v1/conversations/{conv_id}/workspace/files")
        ).status_code == 404
        assert (
            await other.get(
                f"/v1/conversations/{conv_id}/workspace/files/secret.txt"
            )
        ).status_code == 404
        assert (
            await other.get(f"/v1/conversations/{conv_id}/snapshots")
        ).status_code == 404
