"""Network git subcommands: push / pull / create_pr."""

from __future__ import annotations

from typing import Any

from agentcore.tools.protocol import ToolContext, ToolResult

from . import spawn as spawn_mod
from .policy import _PROTECTED_BRANCHES, _ref_token_error, _remote_name_error
from .results import _error, _git_failure, _ok
from .spawn import _cloud_network_extra_env, _current_branch


async def cmd_push(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
    context: ToolContext,
) -> ToolResult:
    """Push current branch to a named remote — never force, never arbitrary refspec."""
    # Reject smuggled force / refspec keys before any network I/O.
    if any(
        k in arguments
        for k in ("force", "force_with_lease", "forceWithLease", "refspec")
    ):
        return _error(
            "禁止 force push 与自定义 refspec（含 --force / -f / --force-with-lease）；"
            "仅允许将当前功能分支推送到指定 remote",
            start,
        )
    if "branch" in arguments and str(arguments.get("branch") or "").strip():
        # Branch is derived from HEAD; accepting an explicit target would reopen
        # feature:main-style bypasses.
        return _error(
            "push 不接受 branch/refspec 参数：只推送当前分支同名到 remote",
            start,
        )

    remote = str(arguments.get("remote") or "origin").strip() or "origin"
    remote_err = _remote_name_error(remote, start)
    if remote_err is not None:
        return remote_err
    if remote in {"-f", "--force", "--force-with-lease"}:
        return _error("禁止 force push", start)

    set_upstream = bool(arguments.get("set_upstream", False))

    branch = await _current_branch(cwd)
    if not branch:
        return _error("无法确定当前分支，拒绝 push", start)
    if branch in _PROTECTED_BRANCHES:
        return _error(
            "禁止从 main/master 推送，请先 checkout 到功能分支后再 push",
            start,
        )

    remotes_out, remotes_err, remotes_code = await spawn_mod._run_git(["remote"], cwd=cwd)
    if remotes_code != 0:
        detail = (remotes_err or remotes_out or "无法列出 remote").strip()
        return _error(detail, start)
    remotes = [line.strip() for line in remotes_out.splitlines() if line.strip()]
    if not remotes:
        return _error(
            "当前仓库未配置 remote。请先配置 remote"
            "（如 git remote add origin <url>），"
            "或到「设置 → Git 凭据」配置 PAT / 打开已配置凭据的本地仓库后再 push。",
            start,
        )
    if remote not in remotes:
        listed = ", ".join(remotes)
        return _error(
            f"remote '{remote}' 不存在（已配置：{listed}）。"
            "请先配置 remote，或到「设置 → Git 凭据」配置 PAT /"
            "打开已配置凭据的本地仓库后再 push。",
            start,
        )

    args = ["push"]
    if set_upstream:
        args.append("--set-upstream")
    # Remote name + current branch only — never a src:dst refspec.
    args.extend([remote, branch])
    # Network-bound; keep under engine outer (push serial=4 × 20s).
    extra = await _cloud_network_extra_env(context)
    stdout, stderr, code = await spawn_mod._run_git(
        args, cwd=cwd, timeout=60.0, extra_env=extra
    )
    if code != 0:
        # Auth / network failures surface honestly (GIT_TERMINAL_PROMPT=0).
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    action = f"已推送 {branch} → {remote}"
    if set_upstream:
        action += "（已设置上游）"
    output = action if not detail else f"{action}\n{detail}"
    return _ok(output, start, metadata={**meta, "remote": remote, "branch": branch})

async def cmd_pull(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
    context: ToolContext,
) -> ToolResult:
    """Pull with ``--ff-only`` — never auto merge/rebase; non-ff fails honestly."""
    # Reject strategy / rebase knobs before any network I/O.
    if any(
        k in arguments
        for k in (
            "rebase",
            "no_ff",
            "no-ff",
            "ff",
            "strategy",
            "allow_unrelated",
            "allowUnrelated",
        )
    ):
        return _error(
            "pull 仅支持快进（固定 --ff-only）；禁止 rebase/merge 策略参数。"
            "非快进或冲突时请人工处理。",
            start,
        )

    remote = str(arguments.get("remote") or "origin").strip() or "origin"
    remote_err = _remote_name_error(remote, start)
    if remote_err is not None:
        return remote_err

    remotes_out, remotes_err, remotes_code = await spawn_mod._run_git(["remote"], cwd=cwd)
    if remotes_code != 0:
        detail = (remotes_err or remotes_out or "无法列出 remote").strip()
        return _error(detail, start)
    remotes = [line.strip() for line in remotes_out.splitlines() if line.strip()]
    if not remotes:
        return _error(
            "当前仓库未配置 remote。请先配置 remote"
            "（如 git remote add origin <url>）后再 pull。",
            start,
        )
    if remote not in remotes:
        listed = ", ".join(remotes)
        return _error(
            f"remote '{remote}' 不存在（已配置：{listed}）。",
            start,
        )

    # Always --ff-only: non-fast-forward / would-be conflicts → git exits non-zero.
    extra = await _cloud_network_extra_env(context)
    stdout, stderr, code = await spawn_mod._run_git(
        ["pull", "--ff-only", remote],
        cwd=cwd,
        timeout=60.0,
        extra_env=extra,
    )
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已快进拉取 {remote}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "remote": remote, "ff_only": True})


async def cmd_create_pr(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
    context: ToolContext,
) -> ToolResult:
    """GitHub-only structured PR create via REST API (G4 · not ``gh`` shell)."""
    from agentcore.workspace.github_pr import (
        CreatePullRequestErr,
        CreatePullRequestOk,
        create_pull_request,
        fetch_default_branch,
        github_auth_available_sync_hint,
        parse_github_remote_url,
        resolve_github_token,
    )

    title = str(arguments.get("title") or "").strip()
    if not title:
        return _error("create_pr 需要 title 参数", start)
    body = str(arguments.get("body") or "")
    remote = str(arguments.get("remote") or "origin").strip() or "origin"
    remote_err = _remote_name_error(remote, start)
    if remote_err is not None:
        return remote_err

    remotes_out, remotes_err, remotes_code = await spawn_mod._run_git(["remote"], cwd=cwd)
    if remotes_code != 0:
        detail = (remotes_err or remotes_out or "无法列出 remote").strip()
        return _error(detail, start)
    remotes = [line.strip() for line in remotes_out.splitlines() if line.strip()]
    if not remotes:
        return _error(
            "当前仓库未配置 remote，无法开 PR。"
            "请先 remote add（如 origin → github.com），"
            f"或配置凭据后再试。\n{github_auth_available_sync_hint()}",
            start,
            metadata={**meta, "code": "no_remote"},
        )
    if remote not in remotes:
        listed = ", ".join(remotes)
        return _error(
            f"remote '{remote}' 不存在（已配置：{listed}）。",
            start,
            metadata={**meta, "code": "no_remote"},
        )

    url_out, url_err, url_code = await spawn_mod._run_git(
        ["remote", "get-url", remote], cwd=cwd
    )
    if url_code != 0:
        return await _git_failure(url_out, url_err, url_code, start, metadata=meta)
    remote_url = url_out.strip()
    repo_ref = parse_github_remote_url(remote_url)
    if repo_ref is None:
        return _error(
            f"create_pr 仅支持 GitHub remote（当前 {remote} = {remote_url}）。"
            "GitLab / 其它托管不在范围内。",
            start,
            metadata={**meta, "code": "not_github"},
        )

    head = str(arguments.get("head") or "").strip()
    if not head:
        head = await _current_branch(cwd)
    if not head:
        return _error("无法确定当前分支（head），拒绝 create_pr", start)
    head_err = _ref_token_error(head, label="create_pr head", start=start)
    if head_err is not None:
        return head_err

    token = await resolve_github_token(user_id=context.user_id)
    if not token:
        return _error(
            f"未配置 GitHub 凭据，无法开 PR。\n{github_auth_available_sync_hint()}",
            start,
            metadata={**meta, "code": "unauthenticated"},
        )

    base = str(arguments.get("base") or "").strip()
    if base:
        base_err = _ref_token_error(base, label="create_pr base", start=start)
        if base_err is not None:
            return base_err

    import httpx

    async with httpx.AsyncClient() as client:
        if not base:
            default = await fetch_default_branch(
                client,
                owner=repo_ref.owner,
                repo=repo_ref.repo,
                token=token,
            )
            if isinstance(default, CreatePullRequestErr):
                return _error(
                    default.message,
                    start,
                    metadata={**meta, "code": default.code},
                )
            base = default

        result = await create_pull_request(
            owner=repo_ref.owner,
            repo=repo_ref.repo,
            title=title,
            body=body,
            head=head,
            base=base,
            token=token,
            client=client,
        )

    if isinstance(result, CreatePullRequestErr):
        return _error(
            result.message,
            start,
            metadata={**meta, "code": result.code},
        )
    assert isinstance(result, CreatePullRequestOk)
    output = (
        f"已创建 PR #{result.number}：{result.title}\n"
        f"{result.head} → {result.base}\n"
        f"{result.html_url}"
    )
    return _ok(
        output,
        start,
        metadata={
            **meta,
            "pr_url": result.html_url,
            "pr_number": result.number,
            "base": result.base,
            "head": result.head,
            "owner": repo_ref.owner,
            "repo": repo_ref.repo,
        },
    )
