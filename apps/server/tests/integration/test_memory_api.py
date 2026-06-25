"""End-to-end API integration tests for the per-leaf memory surface (记忆作用域与画像分层 P2).

Covers the route/DI/serialization chain for ``/v1/users/me/memory/files/{kind}`` and
``/v1/users/me/memory/projects`` against a real PG schema: per-leaf CAS round-trip +
conflict, clearing a leaf, project-scoped 画像 isolated from global, the projects
enumeration the「文件」rail uses, the 偏好-is-always-global invariant, and auth gating.

The memory FILES live on disk via ``FileMemoryStore`` under ``settings.data_dir``; an
autouse fixture points that at a per-test ``tmp_path`` so the suite is hermetic and never
touches the real data dir.
"""

import httpx
import pytest

from agentcore.config import settings

_PW = "password123"


@pytest.fixture(autouse=True)
def _isolated_memory_dir(tmp_path, monkeypatch):
    # default_memory_store() reads settings.data_dir per call, so redirecting it here
    # isolates every test's memory files under its own tmp dir.
    monkeypatch.setattr(settings, "data_dir", str(tmp_path))


async def _register_and_login(client: httpx.AsyncClient, invite_code: str, username: str) -> None:
    r = await client.post(
        "/v1/auth/register",
        json={"username": username, "password": _PW, "invite_code": invite_code},
    )
    assert r.status_code == 201, r.text
    r = await client.post("/v1/auth/login", json={"username": username, "password": _PW})
    assert r.status_code == 200, r.text


async def test_per_file_roundtrip_and_cas(client, make_invite):
    code = await make_invite("INV-MEM-1")
    await _register_and_login(client, code, "mem1")

    # A brand-new user's 偏好 leaf is empty (with a stable empty-content CAS tag).
    r = await client.get("/v1/users/me/memory/files/preferences")
    assert r.status_code == 200, r.text
    empty_version = r.json()["version"]
    assert r.json()["content"] == ""

    # Write it (baseline = the empty tag → conflict-free first write).
    body = "## 沟通偏好\n- 用中文\n"
    r = await client.put(
        "/v1/users/me/memory/files/preferences",
        json={"content": body, "baseline": empty_version},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True and r.json()["conflict"] is False
    new_version = r.json()["version"]

    # It reads back.
    r = await client.get("/v1/users/me/memory/files/preferences")
    assert r.json()["content"] == body and r.json()["version"] == new_version

    # A stale baseline (the old empty tag) is rejected as a conflict, not clobbered.
    r = await client.put(
        "/v1/users/me/memory/files/preferences",
        json={"content": "覆盖?", "baseline": empty_version},
    )
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is False and r.json()["conflict"] is True
    # The live content is untouched.
    assert (await client.get("/v1/users/me/memory/files/preferences")).json()["content"] == body

    # Clearing (empty content, unconditional) drops the leaf.
    r = await client.put(
        "/v1/users/me/memory/files/preferences",
        json={"content": "", "baseline": None},
    )
    assert r.json()["ok"] is True
    assert (await client.get("/v1/users/me/memory/files/preferences")).json()["content"] == ""


async def test_profile_project_scope_isolated_and_enumerated(client, make_invite):
    code = await make_invite("INV-MEM-2")
    await _register_and_login(client, code, "mem2")

    await client.put(
        "/v1/users/me/memory/files/profile",
        json={"content": "全局事实", "baseline": None},
    )
    await client.put(
        "/v1/users/me/memory/files/profile?folder_id=F1",
        json={"content": "本项目事实", "baseline": None},
    )

    # Each layer reads its own body; global and project never bleed into each other.
    g = await client.get("/v1/users/me/memory/files/profile")
    p = await client.get("/v1/users/me/memory/files/profile?folder_id=F1")
    assert g.json()["content"] == "全局事实"
    assert p.json()["content"] == "本项目事实"

    # The rail enumeration surfaces exactly the project that has memory.
    r = await client.get("/v1/users/me/memory/projects")
    assert r.status_code == 200, r.text
    assert r.json()["folders"] == ["F1"]


async def test_preferences_folder_id_is_ignored_and_stays_global(client, make_invite):
    code = await make_invite("INV-MEM-3")
    await _register_and_login(client, code, "mem3")

    # Writing preferences WITH a folder_id still lands on the GLOBAL 偏好 (invariant §1.4).
    await client.put(
        "/v1/users/me/memory/files/preferences?folder_id=F1",
        json={"content": "用中文", "baseline": None},
    )
    assert (await client.get("/v1/users/me/memory/files/preferences")).json()["content"] == "用中文"
    # No project layer was created → the rail shows no project node.
    assert (await client.get("/v1/users/me/memory/projects")).json()["folders"] == []


async def test_memory_files_require_auth(client):
    assert (await client.get("/v1/users/me/memory/files/profile")).status_code == 401
    assert (await client.get("/v1/users/me/memory/projects")).status_code == 401
