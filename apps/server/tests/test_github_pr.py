"""Unit tests for GitHub-only structured create_pr (G4)."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
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

_needs_git = pytest.mark.skipif(not shutil.which("git"), reason="git not installed")
_GIT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


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


def _init_githubish_repo(path: Path, *, remote_url: str) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["git", "init", "-b", "feature"],
        cwd=path,
        check=True,
        env=_GIT_ENV,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.email", "t@e.com"],
        cwd=path,
        check=True,
        env=_GIT_ENV,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "T"],
        cwd=path,
        check=True,
        env=_GIT_ENV,
        capture_output=True,
    )
    (path / "a.txt").write_text("x\n", encoding="utf-8")
    subprocess.run(
        ["git", "add", "a.txt"], cwd=path, check=True, env=_GIT_ENV, capture_output=True
    )
    subprocess.run(
        ["git", "commit", "-m", "init"],
        cwd=path,
        check=True,
        env=_GIT_ENV,
        capture_output=True,
    )
    subprocess.run(
        ["git", "remote", "add", "origin", remote_url],
        cwd=path,
        check=True,
        env=_GIT_ENV,
        capture_output=True,
    )
    return path


def _worker_ctx(workspace: Path):
    from agentcore.tools.protocol import ToolContext
    from agentcore.tools.sandbox.subprocess import SubprocessSandbox
    from agentcore.workspace.server import ServerWorkspace
    from agentcore.workspace.write_claims import WriteCoordinator

    return ToolContext.create(
        execution_id="e",
        run_id="s",
        agent_id="worker",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u1",
        write_coordinator=WriteCoordinator(),
    )


@_needs_git
@pytest.mark.asyncio
async def test_git_tool_create_pr_unauthenticated(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agentcore.tools.builtin.git_ops import GitTool

    repo = _init_githubish_repo(
        tmp_path / "repo", remote_url="https://github.com/acme/demo.git"
    )

    async def _no_tok(*, user_id: str | None) -> None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.github_pr.resolve_github_token",
        _no_tok,
    )

    result = await GitTool().execute(
        {"subcommand": "create_pr", "title": "Hello"},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert result.metadata and result.metadata.get("code") == "unauthenticated"
    assert "Git 凭据" in (result.error or "")


@_needs_git
@pytest.mark.asyncio
async def test_git_tool_create_pr_not_github(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agentcore.tools.builtin.git_ops import GitTool

    repo = _init_githubish_repo(
        tmp_path / "repo", remote_url="https://gitlab.com/acme/demo.git"
    )

    async def _tok(*, user_id: str | None) -> str:
        return "tok"

    monkeypatch.setattr(
        "agentcore.workspace.github_pr.resolve_github_token",
        _tok,
    )

    result = await GitTool().execute(
        {"subcommand": "create_pr", "title": "Hello"},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert result.metadata and result.metadata.get("code") == "not_github"


@_needs_git
@pytest.mark.asyncio
async def test_git_tool_create_pr_success_mocked(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agentcore.tools.builtin.git_ops import GitTool

    repo = _init_githubish_repo(
        tmp_path / "repo", remote_url="https://github.com/acme/demo.git"
    )

    async def _tok(*, user_id: str | None) -> str:
        return "tok"

    async def _create(**kwargs: Any) -> CreatePullRequestOk:
        assert kwargs["owner"] == "acme"
        assert kwargs["repo"] == "demo"
        assert kwargs["title"] == "Hello"
        assert kwargs["head"] == "feature"
        assert kwargs["base"] == "main"
        return CreatePullRequestOk(
            html_url="https://github.com/acme/demo/pull/7",
            number=7,
            title="Hello",
            base="main",
            head="feature",
        )

    monkeypatch.setattr(
        "agentcore.workspace.github_pr.resolve_github_token",
        _tok,
    )
    monkeypatch.setattr(
        "agentcore.workspace.github_pr.create_pull_request",
        _create,
    )

    result = await GitTool().execute(
        {"subcommand": "create_pr", "title": "Hello", "base": "main"},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "https://github.com/acme/demo/pull/7" in (result.output or "")
    assert result.metadata and result.metadata.get("pr_url") == (
        "https://github.com/acme/demo/pull/7"
    )


def test_git_call_is_write_create_pr() -> None:
    from agentcore.core.types import ToolApproval
    from agentcore.runtime.approvals import tool_call_requires_approval
    from agentcore.tools.builtin.git_ops import git_call_is_write

    assert git_call_is_write({"subcommand": "create_pr", "title": "x"}) is True
    assert tool_call_requires_approval(
        "git", ToolApproval.NEVER, {"subcommand": "create_pr", "title": "x"}
    )


def test_create_pr_always_prompts_like_push() -> None:
    from agentcore.core.types import AutonomyPolicy, recipe_to_axes
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
        permission_axes=recipe_to_axes(AutonomyPolicy.LESS_INTERRUPT),
    )
    assert gate.will_prompt(
        tool_name="git",
        arguments={"subcommand": "create_pr", "title": "x"},
    )
    assert not gate.will_prompt(
        tool_name="git",
        arguments={"subcommand": "commit", "message": "x"},
    )
