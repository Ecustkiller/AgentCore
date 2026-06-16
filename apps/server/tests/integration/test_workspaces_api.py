"""Integration tests for the first-class workspace HTTP routes (文件中枢统一 Step 1).

Auto-skips (via the shared ``client`` fixture) when no PostgreSQL is reachable.
Covers: the auth gate; hub enumeration (文件夹即工作区: every folder is a workspace,
local ones marked + carrying root_id; a 裸聊 owns none); the ws-id-addressed file
CRUD / move / dirs / snapshot lifecycle on a folder workspace; the cloud-vs-local
gate (local file/mutation ops 409, read-only snapshot list stays open); and IDOR /
bad-id / conversation-id 404s (a conversation is not a workspace).

``data_dir`` and the storage backend are redirected to a tmp dir so routes never
touch the real ./data tree; the lru-cached storage factory is cleared around each
test so the redirect takes effect.
"""

import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from agentcore.config import settings
from agentcore.storage.factory import build_storage_provider

_PW = "password123"
_ROOT = "11111111-2222-3333-4444-555555555555"


def _init_source_repo(path: Path) -> None:
    """Create a one-commit git repo at ``path`` (cloneable over file://)."""
    path.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}

    def run(*args: str) -> None:
        subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, env=env)

    run("init")
    run("config", "user.email", "tester@example.com")
    run("config", "user.name", "Tester")
    (path / "README.md").write_text("hello clone\n", encoding="utf-8")
    run("add", "README.md")
    run("commit", "-m", "init")


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


async def _new_conversation(client: httpx.AsyncClient, title: str = "chat") -> str:
    r = await client.post("/v1/conversations", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _new_folder(client: httpx.AsyncClient, name: str) -> str:
    r = await client.post("/v1/folders", json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def test_workspaces_requires_auth(client):
    assert (await client.get("/v1/workspaces")).status_code == 401
    assert (await client.get("/v1/workspaces/folder:x/files")).status_code == 401


async def test_folder_workspace_file_crud_by_ws_id(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WSX-1")
    await _register_and_login(client, code, "wsxuser1")
    folder_id = await _new_folder(client, "Proj")
    ws = f"folder:{folder_id}"

    body = b"first-class\x00\x01"
    r = await client.put(f"/v1/workspaces/{ws}/files/docs/a.bin", content=body)
    assert r.status_code == 200, r.text
    assert r.json() == {"path": "docs/a.bin", "size_bytes": len(body)}

    r = await client.get(f"/v1/workspaces/{ws}/files", params={"recursive": "true"})
    assert r.status_code == 200
    assert "docs/a.bin" in {e["path"] for e in r.json()["data"]}

    r = await client.get(f"/v1/workspaces/{ws}/files/docs/a.bin")
    assert r.status_code == 200 and r.content == body

    # mkdir → move → delete round-trip.
    assert (
        await client.post(f"/v1/workspaces/{ws}/dirs", json={"path": "out"})
    ).status_code == 200
    r = await client.post(
        f"/v1/workspaces/{ws}/move", json={"src": "docs/a.bin", "dst": "out/a.bin"}
    )
    assert r.status_code == 200, r.text
    assert (
        await client.get(f"/v1/workspaces/{ws}/files/docs/a.bin")
    ).status_code == 404
    assert (
        await client.delete(f"/v1/workspaces/{ws}/files/out/a.bin")
    ).status_code == 200


async def test_enumeration_lists_folders_only(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WSX-ENUM")
    await _register_and_login(client, code, "wsxenum")
    folder_id = await _new_folder(client, "Alpha")
    bare_conv = await _new_conversation(client, "bare")

    r = await client.get("/v1/workspaces")
    assert r.status_code == 200, r.text
    by_id = {w["ws_id"]: w for w in r.json()["data"]}

    # 文件夹即工作区: the folder always lists (a project is a project, empty or not);
    # a 裸聊 owns no workspace, so it never appears.
    assert f"folder:{folder_id}" in by_id
    assert by_id[f"folder:{folder_id}"]["location"] == "cloud"
    assert f"conv:{bare_conv}" not in by_id


async def test_enumeration_marks_local_binding(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WSX-LOCAL")
    await _register_and_login(client, code, "wsxlocal")
    conv_id = await _new_conversation(client, "bound")
    # Binding a 裸聊 promotes it into a folder workspace bound to the desktop root.
    await client.put(
        f"/v1/conversations/{conv_id}/workspace/binding", json={"root_id": _ROOT}
    )

    r = await client.get("/v1/workspaces")
    locals_ = [w for w in r.json()["data"] if w["location"] == "local"]
    # The promote created exactly one (folder) workspace, marked local.
    assert len(locals_) == 1
    assert locals_[0]["ws_id"].startswith("folder:")
    assert locals_[0]["root_id"] == _ROOT
    assert locals_[0]["has_files"] is True


async def test_enumeration_lists_local_bound_folder(client, make_invite, _fs_data_dir):
    """A folder created with a local binding (F2: 加文件夹=建本地绑定项目) shows in the
    hub as a local workspace carrying its root_id — browsed over IPC, not REST."""
    code = await make_invite("INV-WSX-F2")
    await _register_and_login(client, code, "wsxf2")
    r = await client.post(
        "/v1/folders", json={"name": "LocalProj", "local_root_id": _ROOT}
    )
    assert r.status_code == 201, r.text
    folder_id = r.json()["id"]

    r = await client.get("/v1/workspaces")
    by_id = {w["ws_id"]: w for w in r.json()["data"]}
    entry = by_id[f"folder:{folder_id}"]
    assert entry["location"] == "local"
    assert entry["root_id"] == _ROOT
    assert entry["has_files"] is True

    # Its files live on the desktop, so the server-side REST file list is refused (§五).
    assert (
        await client.get(f"/v1/workspaces/folder:{folder_id}/files")
    ).status_code == 409


async def test_local_workspace_rejects_server_side_ops(
    client, make_invite, _fs_data_dir
):
    """A local workspace's files live on the desktop — server-side file / mutation
    ops are refused (409); read-only snapshot listing stays open (§五)."""
    code = await make_invite("INV-WSX-409")
    await _register_and_login(client, code, "wsx409")
    r = await client.post(
        "/v1/folders", json={"name": "LocalProj", "local_root_id": _ROOT}
    )
    assert r.status_code == 201, r.text
    ws = f"folder:{r.json()['id']}"

    assert (await client.get(f"/v1/workspaces/{ws}/files")).status_code == 409
    assert (
        await client.put(f"/v1/workspaces/{ws}/files/x.txt", content=b"x")
    ).status_code == 409
    assert (
        await client.post(f"/v1/workspaces/{ws}/dirs", json={"path": "d"})
    ).status_code == 409
    assert (
        await client.post(
            f"/v1/workspaces/{ws}/move", json={"src": "a", "dst": "b"}
        )
    ).status_code == 409
    assert (await client.post(f"/v1/workspaces/{ws}/snapshots", json={})).status_code == 409
    assert (
        await client.post(f"/v1/workspaces/{ws}/snapshots/x/restore")
    ).status_code == 409
    # Read-only snapshot listing is allowed (object-store backed, ws-keyed).
    assert (await client.get(f"/v1/workspaces/{ws}/snapshots")).status_code == 200


async def test_snapshot_lifecycle_by_ws_id(client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WSX-SNAP")
    await _register_and_login(client, code, "wsxsnap")
    folder_id = await _new_folder(client, "Snaps")
    ws = f"folder:{folder_id}"

    await client.put(f"/v1/workspaces/{ws}/files/doc.txt", content=b"v1")
    r = await client.post(f"/v1/workspaces/{ws}/snapshots", json={"label": "m1"})
    assert r.status_code == 201, r.text
    sid = r.json()["snapshot_id"]

    assert sid in {
        s["snapshot_id"]
        for s in (await client.get(f"/v1/workspaces/{ws}/snapshots")).json()["data"]
    }

    await client.put(f"/v1/workspaces/{ws}/files/doc.txt", content=b"v2")
    assert (
        await client.post(f"/v1/workspaces/{ws}/snapshots/{sid}/restore")
    ).status_code == 200
    assert (await client.get(f"/v1/workspaces/{ws}/files/doc.txt")).content == b"v1"

    r = await client.get(f"/v1/workspaces/{ws}/snapshots/{sid}/download")
    assert r.status_code == 200 and r.content[:2] == b"PK"
    assert (
        await client.post(f"/v1/workspaces/{ws}/snapshots/nope/restore")
    ).status_code == 404


async def test_clone_repo_by_ws_id(
    client, make_invite, _fs_data_dir, tmp_path, monkeypatch
):
    if shutil.which("git") is None:
        pytest.skip("git not installed")
    src = tmp_path / "source-repo"
    _init_source_repo(src)
    from agentcore.workspace import git as gitmod

    monkeypatch.setattr(gitmod, "_validate_url", lambda url: None)

    code = await make_invite("INV-WSX-CLONE")
    await _register_and_login(client, code, "wsxclone")
    folder_id = await _new_folder(client, "CloneProj")
    ws = f"folder:{folder_id}"

    r = await client.post(
        f"/v1/workspaces/{ws}/clone", json={"repo_url": src.as_uri(), "dest": "imp"}
    )
    assert r.status_code == 200, r.text
    r = await client.get(f"/v1/workspaces/{ws}/files/imp/README.md")
    assert r.status_code == 200
    assert r.content.replace(b"\r\n", b"\n") == b"hello clone\n"


async def test_bad_and_foreign_ws_ids_404(client, new_client, make_invite, _fs_data_dir):
    code = await make_invite("INV-WSX-IDOR")
    await _register_and_login(client, code, "wsxowner")
    folder_id = await _new_folder(client, "Mine")
    conv_id = await _new_conversation(client, "filed")

    assert (await client.get("/v1/workspaces/garbage/files")).status_code == 404
    assert (await client.get("/v1/workspaces/team:abc/files")).status_code == 404
    assert (
        await client.get(f"/v1/workspaces/folder:{conv_id}/files")
    ).status_code == 404
    # 文件夹即工作区: a conversation is never a workspace, so the conv-id form is 404.
    assert (await client.get(f"/v1/workspaces/conv:{conv_id}/files")).status_code == 404

    # A different user can't reach the owner's folder workspace (IDOR-safe 404).
    code_b = await make_invite("INV-WSX-IDOR-B")
    async with new_client() as other:
        await _register_and_login(other, code_b, "wsxintruder")
        assert (
            await other.get(f"/v1/workspaces/folder:{folder_id}/files")
        ).status_code == 404


async def test_file_index_lists_files_pruning_ignored(
    client, make_invite, _fs_data_dir
):
    """The @ mention index (文件中枢统一 F4) is a flat, files-only path list with
    noise dirs (node_modules/.git…) pruned — the cloud counterpart to the desktop
    fsApi.listFiles that indexes local roots, so @ behaves the same either way."""
    code = await make_invite("INV-WSX-IDX")
    await _register_and_login(client, code, "wsxidx")
    folder_id = await _new_folder(client, "Idx")
    ws = f"folder:{folder_id}"

    await client.put(f"/v1/workspaces/{ws}/files/src/app.ts", content=b"a")
    await client.put(f"/v1/workspaces/{ws}/files/README.md", content=b"r")
    # Noise that must be pruned, just like local indexing skips it.
    await client.put(
        f"/v1/workspaces/{ws}/files/node_modules/dep/index.js", content=b"x"
    )
    await client.put(f"/v1/workspaces/{ws}/files/.git/config", content=b"g")

    r = await client.get(f"/v1/workspaces/{ws}/file-index")
    assert r.status_code == 200, r.text
    body = r.json()
    # Files only (no dirs), POSIX paths, ignored dirs pruned.
    assert set(body["data"]) == {"README.md", "src/app.ts"}
    assert body["total"] == 2
    assert body["truncated"] is False


async def test_file_index_local_workspace_rejected(client, make_invite, _fs_data_dir):
    """Local workspaces are indexed on the desktop over IPC, so the server-side
    file-index is refused with 409 like other cloud-only file ops (§五)."""
    code = await make_invite("INV-WSX-IDX-L")
    await _register_and_login(client, code, "wsxidxl")
    r = await client.post(
        "/v1/folders", json={"name": "LocalIdx", "local_root_id": _ROOT}
    )
    assert r.status_code == 201, r.text
    assert (
        await client.get(f"/v1/workspaces/folder:{r.json()['id']}/file-index")
    ).status_code == 409
