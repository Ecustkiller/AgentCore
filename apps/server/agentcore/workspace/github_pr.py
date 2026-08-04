"""GitHub-only structured pull-request create (G4).

Calls ``api.github.com`` with an account PAT (G3) or local ``gh`` / env token.
Never shells out to ``gh pr create`` as the primary path; tools never accept
password parameters.
"""

from __future__ import annotations

import asyncio
import os
import re
import shutil
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, unquote, urlparse

import httpx

from agentcore.core.logging import get_logger

logger = get_logger(__name__)

_GITHUB_API = "https://api.github.com"
_GITHUB_HOSTS = frozenset({"github.com", "www.github.com"})
# git@github.com:owner/repo(.git)
_SSH_SCP = re.compile(
    r"^git@github\.com:(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$",
    re.IGNORECASE,
)
_AUTH_HINT = (
    "需要 GitHub 凭据：请到「设置 → Git 凭据」配置账户级 PAT（需 repo 权限），"
    "或在本机完成 gh auth login / 设置 GH_TOKEN 后再试。"
)


@dataclass(frozen=True, slots=True)
class GithubRepoRef:
    owner: str
    repo: str


@dataclass(frozen=True, slots=True)
class CreatePullRequestOk:
    html_url: str
    number: int
    title: str
    base: str
    head: str


@dataclass(frozen=True, slots=True)
class CreatePullRequestErr:
    message: str
    code: str


CreatePullRequestResult = CreatePullRequestOk | CreatePullRequestErr


def parse_github_remote_url(url: str) -> GithubRepoRef | None:
    """Parse a git remote URL into ``owner/repo`` when the host is github.com."""
    raw = (url or "").strip()
    if not raw:
        return None

    scp = _SSH_SCP.match(raw)
    if scp is not None:
        return GithubRepoRef(owner=scp.group("owner"), repo=scp.group("repo"))

    # ssh://git@github.com/owner/repo(.git)
    try:
        parsed = urlparse(raw)
    except ValueError:
        return None

    host = (parsed.hostname or "").lower()
    if host not in _GITHUB_HOSTS:
        return None
    parts = [unquote(p) for p in (parsed.path or "").split("/") if p]
    if len(parts) < 2:
        return None
    owner, repo = parts[0], parts[1]
    if repo.endswith(".git"):
        repo = repo[: -len(".git")]
    if not owner or not repo or owner.startswith("."):
        return None
    return GithubRepoRef(owner=owner, repo=repo)


async def resolve_github_token(*, user_id: str | None) -> str | None:
    """Resolve a GitHub token: account PAT → env → ``gh auth token``.

    Cloud and Local both prefer the account PAT (G3). Local may fall back to
    process env / installed ``gh``; never log the token.
    """
    if user_id:
        from agentcore.workspace.git_credentials import load_git_auth_for_user

        auth = await load_git_auth_for_user(user_id)
        if auth is not None and auth.token.strip():
            return auth.token.strip()

    for key in ("GH_TOKEN", "GITHUB_TOKEN"):
        env_tok = (os.environ.get(key) or "").strip()
        if env_tok:
            return env_tok

    return await _gh_auth_token()


async def _gh_auth_token() -> str | None:
    """Best-effort local ``gh auth token``; ``None`` if gh missing / not logged in."""
    if not shutil.which("gh"):
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "gh",
            "auth",
            "token",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "GH_PROMPT_DISABLED": "1"},
        )
        stdout_b, _ = await asyncio.wait_for(proc.communicate(), timeout=8.0)
    except (TimeoutError, OSError, asyncio.CancelledError):
        return None
    if (proc.returncode or 0) != 0:
        return None
    token = stdout_b.decode("utf-8", errors="replace").strip()
    return token or None


def github_auth_available_sync_hint() -> str:
    """User-facing hint when no token could be resolved."""
    return _AUTH_HINT


async def fetch_default_branch(
    client: httpx.AsyncClient,
    *,
    owner: str,
    repo: str,
    token: str,
) -> str | CreatePullRequestErr:
    url = f"{_GITHUB_API}/repos/{quote(owner)}/{quote(repo)}"
    try:
        resp = await client.get(url, headers=_api_headers(token), timeout=20.0)
    except httpx.HTTPError as exc:
        return CreatePullRequestErr(
            message=f"无法查询仓库默认分支：{type(exc).__name__}",
            code="network_error",
        )
    if resp.status_code == 404:
        return CreatePullRequestErr(
            message="GitHub 仓库不存在或当前凭据无权访问（404）。",
            code="not_found",
        )
    if resp.status_code in (401, 403):
        return CreatePullRequestErr(
            message=f"GitHub 凭据无效或权限不足（HTTP {resp.status_code}）。\n{_AUTH_HINT}",
            code="auth_failed",
        )
    if resp.status_code >= 400:
        return CreatePullRequestErr(
            message=_api_error_message(resp, fallback="查询默认分支失败"),
            code="api_error",
        )
    try:
        data = resp.json()
    except ValueError:
        return CreatePullRequestErr(message="GitHub API 返回非 JSON", code="api_error")
    default = str(data.get("default_branch") or "").strip()
    if not default:
        return CreatePullRequestErr(
            message="仓库未声明 default_branch",
            code="no_default_branch",
        )
    return default


async def create_pull_request(
    *,
    owner: str,
    repo: str,
    title: str,
    body: str,
    head: str,
    base: str,
    token: str,
    client: httpx.AsyncClient | None = None,
) -> CreatePullRequestResult:
    """POST ``/repos/{owner}/{repo}/pulls`` and return the PR HTML URL."""
    title = title.strip()
    if not title:
        return CreatePullRequestErr(message="title 不能为空", code="invalid_args")
    head = head.strip()
    base = base.strip()
    if not head or not base:
        return CreatePullRequestErr(message="head / base 不能为空", code="invalid_args")
    if head.startswith("-") or base.startswith("-"):
        return CreatePullRequestErr(
            message="head / base 不能以 '-' 开头",
            code="invalid_args",
        )

    payload: dict[str, Any] = {
        "title": title,
        "head": head,
        "base": base,
        "body": body,
    }
    url = f"{_GITHUB_API}/repos/{quote(owner)}/{quote(repo)}/pulls"
    own_client = client is None
    http = client or httpx.AsyncClient()
    try:
        try:
            resp = await http.post(
                url, headers=_api_headers(token), json=payload, timeout=30.0
            )
        except httpx.HTTPError as exc:
            return CreatePullRequestErr(
                message=f"创建 PR 网络失败：{type(exc).__name__}",
                code="network_error",
            )
    finally:
        if own_client:
            await http.aclose()

    if resp.status_code in (401, 403):
        return CreatePullRequestErr(
            message=f"GitHub 凭据无效或权限不足（HTTP {resp.status_code}）。\n{_AUTH_HINT}",
            code="auth_failed",
        )
    if resp.status_code == 404:
        return CreatePullRequestErr(
            message="GitHub 仓库不存在或当前凭据无权开 PR（404）。",
            code="not_found",
        )
    if resp.status_code == 422:
        detail = _api_error_message(resp, fallback="无法创建 PR（422）")
        return CreatePullRequestErr(message=detail, code="validation_failed")
    if resp.status_code >= 400:
        return CreatePullRequestErr(
            message=_api_error_message(resp, fallback=f"创建 PR 失败（HTTP {resp.status_code}）"),
            code="api_error",
        )

    try:
        data = resp.json()
    except ValueError:
        return CreatePullRequestErr(message="GitHub API 返回非 JSON", code="api_error")

    html_url = str(data.get("html_url") or "").strip()
    number = data.get("number")
    if not html_url or not isinstance(number, int):
        return CreatePullRequestErr(
            message="GitHub API 未返回 PR URL / number",
            code="api_error",
        )
    logger.info(
        "git.create_pr.ok",
        owner=owner,
        repo=repo,
        number=number,
        base=base,
        head=head,
    )
    return CreatePullRequestOk(
        html_url=html_url,
        number=number,
        title=str(data.get("title") or title),
        base=base,
        head=head,
    )


def _api_headers(token: str) -> dict[str, str]:
    return {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "AgentCore-git-create-pr",
    }


def _api_error_message(resp: httpx.Response, *, fallback: str) -> str:
    try:
        data = resp.json()
    except ValueError:
        text = (resp.text or "").strip()
        return f"{fallback}：{text[:400]}" if text else fallback
    msg = str(data.get("message") or fallback)
    errors = data.get("errors")
    if isinstance(errors, list) and errors:
        bits: list[str] = []
        for err in errors[:5]:
            if isinstance(err, dict):
                bits.append(str(err.get("message") or err))
            else:
                bits.append(str(err))
        if bits:
            detail = "; ".join(bits)
            msg = f"{msg}（{detail}）"
    return msg
