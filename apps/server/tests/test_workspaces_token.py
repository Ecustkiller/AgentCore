"""Workspaces narrow token + sidecar remote cloud-desk backend."""

from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace

import httpx
import pytest

from agentcore.core.errors import AuthenticationError
from agentcore.security import (
    create_access_token,
    create_account_token,
    create_folders_token,
    create_inference_token,
    create_workspaces_token,
    decode_access_token,
    decode_account_token,
    decode_folders_token,
    decode_inference_token,
    decode_workspaces_token,
)
from agentcore.workspace.cloud_credentials import (
    WorkspacesCredentials,
    workspaces_credentials_scope,
)
from agentcore.workspace.protocol import PathNotFound, WorkspaceIOError
from agentcore.workspace.remote import RemoteCloudWorkspace

pytestmark = pytest.mark.anyio


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, handler) -> None:
        self._handler = handler

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return await self._handler(request)


# --- token mutual exclusion ---------------------------------------------------


def test_workspaces_token_roundtrip():
    token = create_workspaces_token("user-1")
    assert decode_workspaces_token(token) == "user-1"


def test_workspaces_token_rejects_other_types():
    others = (
        create_access_token("user-1", audience="product"),
        create_inference_token("user-1"),
        create_folders_token("user-1"),
        create_account_token("user-1"),
    )
    for other in others:
        with pytest.raises(AuthenticationError):
            decode_workspaces_token(other)


def test_other_decoders_reject_workspaces_token():
    workspaces = create_workspaces_token("user-1")
    with pytest.raises(AuthenticationError):
        decode_access_token(workspaces)
    with pytest.raises(AuthenticationError):
        decode_inference_token(workspaces)
    with pytest.raises(AuthenticationError):
        decode_folders_token(workspaces)
    with pytest.raises(AuthenticationError):
        decode_account_token(workspaces)


def test_workspaces_token_rejects_expired():
    expired = create_workspaces_token("user-1", expires_delta=timedelta(minutes=-1))
    with pytest.raises(AuthenticationError):
        decode_workspaces_token(expired)


async def test_mint_workspaces_token_response():
    from agentcore.api.routes.workspaces import mint_workspaces_token

    user = SimpleNamespace(user_id="u1")
    resp = await mint_workspaces_token(user)  # type: ignore[arg-type]
    assert resp.expires_in_sec > 0
    assert decode_workspaces_token(resp.token) == "u1"


async def test_workspaces_api_user_accepts_workspaces_bearer():
    from agentcore.api import dependencies as deps

    user = SimpleNamespace(user_id="u1", status="active", role="user")

    class _Repo:
        async def get_by_id(self, user_id: str):
            assert user_id == "u1"
            return user

    request = SimpleNamespace(
        url=SimpleNamespace(path="/v1/workspaces/folder:f1/files"),
        state=SimpleNamespace(),
    )
    token = create_workspaces_token("u1")
    got = await deps.get_workspaces_api_user(
        request,  # type: ignore[arg-type]
        access_token=None,
        authorization=f"Bearer {token}",
        user_repo=_Repo(),  # type: ignore[arg-type]
    )
    assert got.user_id == "u1"


async def test_workspaces_api_user_rejects_folders_account_inference():
    from agentcore.api import dependencies as deps

    class _Repo:
        async def get_by_id(self, user_id: str):
            raise AssertionError("should not load user")

    request = SimpleNamespace(
        url=SimpleNamespace(path="/v1/workspaces/folder:f1/files"),
        state=SimpleNamespace(),
    )
    for token in (
        create_folders_token("u1"),
        create_account_token("u1"),
        create_inference_token("u1"),
    ):
        with pytest.raises(AuthenticationError):
            await deps.get_workspaces_api_user(
                request,  # type: ignore[arg-type]
                access_token=None,
                authorization=f"Bearer {token}",
                user_repo=_Repo(),  # type: ignore[arg-type]
            )


async def test_folders_api_user_rejects_workspaces_bearer():
    from agentcore.api import dependencies as deps

    class _Repo:
        async def get_by_id(self, user_id: str):
            raise AssertionError("should not load user")

    request = SimpleNamespace(url=SimpleNamespace(path="/v1/folders"), state=SimpleNamespace())
    token = create_workspaces_token("u1")
    with pytest.raises(AuthenticationError):
        await deps.get_folders_api_user(
            request,  # type: ignore[arg-type]
            access_token=None,
            authorization=f"Bearer {token}",
            user_repo=_Repo(),  # type: ignore[arg-type]
        )


def test_parse_workspaces_auth_from_sidecar_params():
    from agentcore.sidecar.server_pkg.handlers import HandlerMixin

    creds = HandlerMixin._parse_workspaces_auth(
        {
            "workspacesAuth": {
                "baseUrl": "https://api.example/v1/workspaces",
                "apiKey": "ws-jwt",
            }
        }
    )
    assert creds is not None
    assert creds.base_url == "https://api.example/v1/workspaces"
    assert creds.api_key == "ws-jwt"
    assert HandlerMixin._parse_workspaces_auth({}) is None
    assert (
        HandlerMixin._parse_workspaces_auth(
            {"workspacesAuth": {"baseUrl": "", "apiKey": "x"}}
        )
        is None
    )


# --- remote HTTP client -------------------------------------------------------


@pytest.fixture
def workspaces_creds() -> WorkspacesCredentials:
    return WorkspacesCredentials(
        api_key="ws-jwt",
        base_url="https://cloud.example/v1/workspaces",
    )


async def test_remote_missing_ticket_fails_honestly():
    ws = RemoteCloudWorkspace(ws_id="folder:f1")
    with pytest.raises(WorkspaceIOError, match="缺少工作区凭证"):
        await ws.read("a.txt")


async def test_remote_read_write_and_unauthorized(
    monkeypatch: pytest.MonkeyPatch, workspaces_creds: WorkspacesCredentials
):
    store: dict[str, bytes] = {}

    async def _handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Authorization"] == "Bearer ws-jwt"
        path = request.url.path
        if request.method == "PUT" and path.endswith("/files/note.md"):
            store["note.md"] = request.content
            return httpx.Response(200, json={"path": "note.md", "size_bytes": len(request.content)})
        if request.method == "GET" and path.endswith("/files/note.md"):
            data = store.get("note.md")
            if data is None:
                return httpx.Response(404, json={"message": "文件不存在"})
            return httpx.Response(200, content=data)
        if request.method == "GET" and path.endswith("/files/secret.md"):
            return httpx.Response(401, json={"message": "unauthorized"})
        return httpx.Response(500, json={"message": f"unexpected {request.method} {path}"})

    monkeypatch.setattr(
        "agentcore.workspace.remote.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    with workspaces_credentials_scope(workspaces_creds):
        ws = RemoteCloudWorkspace(ws_id="folder:f1")
        assert ws.location == "server"
        n = await ws.write("note.md", "hello")
        assert n == 5
        assert await ws.read("note.md") == "hello"
        with pytest.raises(WorkspaceIOError, match="workspaces_cloud_unauthorized"):
            await ws.read("secret.md")


async def test_remote_list_index_mkdir_delete(
    monkeypatch: pytest.MonkeyPatch, workspaces_creds: WorkspacesCredentials
):
    async def _handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if request.method == "GET" and path.endswith("/files"):
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"path": "a.txt", "is_dir": False, "size_bytes": 1, "mtime_ms": 1},
                        {"path": "sub", "is_dir": True, "size_bytes": None, "mtime_ms": 2},
                    ],
                    "truncated": False,
                },
            )
        if request.method == "GET" and path.endswith("/file-index"):
            return httpx.Response(
                200, json={"data": ["a.txt", "sub/b.txt"], "truncated": False}
            )
        if request.method == "POST" and path.endswith("/dirs"):
            return httpx.Response(200, json={"status": "ok"})
        if request.method == "DELETE" and "/files/" in path:
            return httpx.Response(200, json={"status": "ok"})
        if request.method == "GET" and path.endswith("/files/missing.txt"):
            return httpx.Response(404, json={"message": "文件不存在"})
        return httpx.Response(500, json={"message": f"unexpected {request.method} {path}"})

    monkeypatch.setattr(
        "agentcore.workspace.remote.outbound_async_client",
        lambda **kwargs: httpx.AsyncClient(transport=_FakeTransport(_handler), **kwargs),
    )
    with workspaces_credentials_scope(workspaces_creds):
        ws = RemoteCloudWorkspace(ws_id="folder:f1")
        listing = await ws.list(".", "*")
        assert [e.path for e in listing.entries] == ["a.txt", "sub"]
        index = await ws.index_files()
        assert index.paths == ["a.txt", "sub/b.txt"]
        assert await ws.exists("a.txt") is True
        assert await ws.exists("sub") is False
        assert await ws.exists("nope.txt") is False
        await ws.mkdir("newdir")
        await ws.delete("a.txt")
        with pytest.raises(PathNotFound):
            await ws.read("missing.txt")
