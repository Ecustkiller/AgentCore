"""Local mutate git subcommands: add / commit / checkout."""

from __future__ import annotations

from typing import Any

from agentcore.tools.protocol import ToolResult

from . import spawn as spawn_mod
from .policy import _PROTECTED_BRANCHES, _validate_add_paths
from .results import _error, _git_failure, _ok
from .spawn import _current_branch


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
