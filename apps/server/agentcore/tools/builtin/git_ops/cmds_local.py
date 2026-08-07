"""Local mutate git subcommands: init_baseline / add / commit / branch / checkout."""

from __future__ import annotations

from typing import Any

from agentcore.tools.protocol import ToolResult

from . import spawn as spawn_mod
from .policy import (
    _ALREADY_REPO_CODE,
    _DIRTY_SKIP_CODE,
    _INIT_BASELINE_AUTHOR_EMAIL,
    _INIT_BASELINE_AUTHOR_NAME,
    _INIT_BASELINE_MESSAGE,
    _PROTECTED_BRANCHES,
    _validate_add_paths,
)
from .results import _error, _git_failure, _ok
from .spawn import _current_branch, _workspace_has_git_meta


async def cmd_init_baseline(
    cwd: str,
    start: float,
    *,
    meta: dict[str, Any],
) -> ToolResult:
    """Init repo + first commit when missing; never force-commit a dirty existing tree."""
    if await _workspace_has_git_meta(cwd):
        porcelain, stderr, code = await spawn_mod._run_git(
            ["status", "--porcelain"], cwd=cwd
        )
        if code != 0:
            return await _git_failure(porcelain, stderr, code, start, metadata=meta)
        if porcelain.strip():
            return _ok(
                "已有 Git 仓库且工作区有未提交改动，不代为 commit。"
                "请用 status/diff 查看后由用户决定是否提交。",
                start,
                metadata={**meta, "code": _DIRTY_SKIP_CODE},
            )
        return _ok(
            "已有 Git 仓库且工作区干净，无需 init_baseline。",
            start,
            metadata={**meta, "code": _ALREADY_REPO_CODE},
        )

    init_out, init_err, init_code = await spawn_mod._run_git(["init"], cwd=cwd)
    if init_code != 0:
        return await _git_failure(init_out, init_err, init_code, start, metadata=meta)

    add_out, add_err, add_code = await spawn_mod._run_git(["add", "-A"], cwd=cwd)
    if add_code != 0:
        return await _git_failure(add_out, add_err, add_code, start, metadata=meta)

    commit_args = [
        "-c",
        f"user.name={_INIT_BASELINE_AUTHOR_NAME}",
        "-c",
        f"user.email={_INIT_BASELINE_AUTHOR_EMAIL}",
        "commit",
        "--allow-empty",
        "-m",
        _INIT_BASELINE_MESSAGE,
    ]
    commit_out, commit_err, commit_code = await spawn_mod._run_git(commit_args, cwd=cwd)
    if commit_code != 0:
        return await _git_failure(
            commit_out, commit_err, commit_code, start, metadata=meta
        )

    sha, _, sha_code = await spawn_mod._run_git(["rev-parse", "--short", "HEAD"], cwd=cwd)
    short = sha.strip() if sha_code == 0 else ""
    branch = await _current_branch(cwd)
    bits = ["已初始化 Git 并完成首提交（AgentCore baseline）"]
    if short:
        bits.append(f"HEAD={short}")
    if branch:
        bits.append(f"分支={branch}")
    return _ok(
        "；".join(bits) + "。",
        start,
        metadata={**meta, "sha": short or None, "branch": branch or None},
    )


async def cmd_add(
    cwd: str, paths: list[str], start: float, *, meta: dict[str, Any]
) -> ToolResult:
    path_err = _validate_add_paths(paths, start)
    if path_err is not None:
        return path_err
    args = ["add", "--", *paths]
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    listed = ", ".join(paths)
    detail = (stdout or stderr).strip()
    output = f"已暂存：{listed}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata=meta)

async def cmd_commit(
    cwd: str, message: str, start: float, *, meta: dict[str, Any]
) -> ToolResult:
    if not message:
        return _error("commit 需要 message 参数", start)
    branch = await _current_branch(cwd)
    if branch in _PROTECTED_BRANCHES:
        return _error(
            "禁止在 main/master 分支直接提交，请先 checkout 到功能分支",
            start,
        )
    stdout, stderr, code = await spawn_mod._run_git(["commit", "-m", message], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    sha, _, sha_code = await spawn_mod._run_git(["rev-parse", "--short", "HEAD"], cwd=cwd)
    short_sha = sha.strip() if sha_code == 0 else ""
    output = f"已提交 {short_sha}：{message}" if short_sha else f"已提交：{message}"
    detail = (stdout or stderr).strip()
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata=meta)

async def cmd_branch(
    cwd: str, branch: str, start: float, *, meta: dict[str, Any]
) -> ToolResult:
    if not branch:
        return _error("branch 需要 branch 参数", start)
    if branch.startswith("-"):
        return _error("分支名不能以 '-' 开头（防止被 git 解析为选项）", start)
    stdout, stderr, code = await spawn_mod._run_git(["branch", branch], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已创建分支 {branch}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata=meta)

async def cmd_checkout(
    cwd: str,
    branch: str,
    *,
    create: bool,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    if not branch:
        return _error("checkout 需要 branch 参数", start)
    if branch.startswith("-"):
        return _error("分支名不能以 '-' 开头（防止被 git 解析为选项）", start)
    args = ["checkout"]
    if create:
        args.extend(["-b", branch])
    else:
        args.append(branch)
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    action = "已创建并切换到分支" if create else "已切换到分支"
    detail = (stdout or stderr).strip()
    output = f"{action} {branch}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata=meta)

