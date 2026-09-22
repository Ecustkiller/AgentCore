"""Unit tests for GitHub pull-request helpers and the run-command confirm."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from agentcore.workspace.github_pr import (
    CreatePullRequestErr,
    CreatePullRequestOk,
    create_pull_request,
    fetch_default_branch,
    parse_github_remote_url,
    resolve_github_token,
)


@pytest.mark.parametrize(
    ("url", "owner", "repo"),
    [
        ("https://github.com/acme/demo.git", "acme", "demo"),
        ("https://github.com/acme/demo", "acme", "demo"),
        ("git@github.com:acme/demo.git", "acme", "demo"),
        ("ssh://git@github.com/acme/demo.git", "acme", "demo"),
        ("https://www.github.com/Org/Repo.git", "Org", "Repo"),
    ],
)
def test_parse_github_remote_url_ok(url: str, owner: str, repo: str) -> None:
    ref = parse_github_remote_url(url)
    assert ref is not None
    assert ref.owner == owner
    assert ref.repo == repo


@pytest.mark.parametrize(
    "url",
    [
        "",
        "https://gitlab.com/acme/demo.git",
        "git@gitlab.com:acme/demo.git",
        "https://github.com/acme",
        "not-a-url",
    ],
)
def test_parse_github_remote_url_rejects_non_github(url: str) -> None:
    assert parse_github_remote_url(url) is None


@pytest.mark.asyncio
async def test_resolve_github_token_prefers_account_pat(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Auth:
        token = "pat-from-account"
        username = "x-access-token"

    async def _load(_uid: str) -> Any:
        return _Auth()

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    monkeypatch.setenv("GH_TOKEN", "env-token")
    tok = await resolve_github_token(user_id="u1")
    assert tok == "pat-from-account"


@pytest.mark.asyncio
async def test_resolve_github_token_falls_back_to_env(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _load(_uid: str) -> None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.setenv("GH_TOKEN", "env-only")

    async def _no_gh() -> None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.github_pr._gh_auth_token",
        _no_gh,
    )
    tok = await resolve_github_token(user_id="u1")
    assert tok == "env-only"


@pytest.mark.asyncio
async def test_resolve_github_token_none_when_unauthenticated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _load(_uid: str) -> None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    monkeypatch.delenv("GH_TOKEN", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)

    async def _no_gh() -> None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.github_pr._gh_auth_token",
        _no_gh,
    )
    assert await resolve_github_token(user_id="u1") is None


class _FakeTransport(httpx.AsyncBaseTransport):
    def __init__(self, handler) -> None:  # noqa: ANN001
        self._handler = handler

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        return self._handler(request)


@pytest.mark.asyncio
async def test_create_pull_request_returns_url() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert "api.github.com" in str(request.url)
        assert request.url.path.endswith("/repos/acme/demo/pulls")
        assert request.headers["Authorization"] == "Bearer tok"
        return httpx.Response(
            201,
            json={
                "html_url": "https://github.com/acme/demo/pull/42",
                "number": 42,
                "title": "Feat",
            },
            request=request,
        )

    async with httpx.AsyncClient(transport=_FakeTransport(handler)) as client:
        result = await create_pull_request(
            owner="acme",
            repo="demo",
            title="Feat",
            body="body",
            head="feature",
            base="main",
            token="tok",
            client=client,
        )
    assert isinstance(result, CreatePullRequestOk)
    assert result.html_url == "https://github.com/acme/demo/pull/42"
    assert result.number == 42


@pytest.mark.asyncio
async def test_create_pull_request_auth_failed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"message": "Bad credentials"}, request=request)

    async with httpx.AsyncClient(transport=_FakeTransport(handler)) as client:
        result = await create_pull_request(
            owner="acme",
            repo="demo",
            title="Feat",
            body="",
            head="feature",
            base="main",
            token="bad",
            client=client,
        )
    assert isinstance(result, CreatePullRequestErr)
    assert result.code == "auth_failed"
    assert "设置 → Git 凭据" in result.message


@pytest.mark.asyncio
async def test_fetch_default_branch() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/repos/acme/demo")
        return httpx.Response(
            200,
            json={"default_branch": "develop"},
            request=request,
        )

    async with httpx.AsyncClient(transport=_FakeTransport(handler)) as client:
        result = await fetch_default_branch(
            client, owner="acme", repo="demo", token="tok"
        )
    assert result == "develop"


def test_gh_pr_create_always_confirms() -> None:
    from agentcore.runtime.always_confirm import requires_always_confirm

    assert requires_always_confirm("run", {"command": "gh pr create --title x"})


def test_create_pr_always_prompts_like_push() -> None:
    from agentcore.core.types import WorkspaceBoundary
    from agentcore.runtime.approvals import ApprovalGate
    from agentcore.runtime.events import EventSink
    from agentcore.runtime.interaction import InteractionRegistry
    from agentcore.tools.builtin import (
        approval_class_tool_names,
        delegation_grantable_tool_names,
    )

    gate = ApprovalGate(
        sink=EventSink(),
        conversation_id="c1",
        registry=InteractionRegistry(),
        timeout_seconds=5.0,
        file_op_tools=approval_class_tool_names(),
        delegation_grantable_tools=delegation_grantable_tool_names(),
        permission_axes=WorkspaceBoundary.FOLDER,
    )
    from agentcore.runtime.always_confirm import requires_always_confirm

    assert gate.will_prompt(
        tool_name="run",
        arguments={"command": "gh pr create --title x"},
    )
    assert not requires_always_confirm("run", {"command": "git commit -m x"})
