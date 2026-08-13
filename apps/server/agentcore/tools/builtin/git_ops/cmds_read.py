"""Read-only git subcommands: status / diff / log / fetch / show / blame."""

from __future__ import annotations

from typing import Any

from agentcore.core.text import truncate_head_tail
from agentcore.tools.protocol import ToolContext, ToolResult

from . import policy as policy_mod
from . import spawn as spawn_mod
from .phases import PHASE_REMOTE
from .policy import _remote_name_error
from .results import _error, _git_failure, _ok, _truncate_line_output
from .spawn import _cloud_network_extra_env, _parse_status_sb


async def cmd_status(
    cwd: str,
    paths: list[str],
    start: float,
    *,
    include_untracked: bool,
    meta: dict[str, Any],
) -> ToolResult:
    # Single subprocess: branch header + porcelain (avoids branch + status serial).
    args = ["status", "-sb"]
    if not include_untracked:
        args.append("--untracked-files=no")
    if paths:
        args.extend(["--", *paths])
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    branch, body = _parse_status_sb(stdout)
    body, truncated, total = _truncate_line_output(
        body, limit=policy_mod._STATUS_LINE_LIMIT, hint="请用 paths 收窄范围"
    )
    output = f"## 当前分支: {branch}\n"
    output += body if body else "（工作区干净）"
    out_meta = {
        **meta,
        "include_untracked": include_untracked,
        "truncated": truncated,
        "status_lines": total,
    }
    return _ok(output, start, metadata=out_meta)

async def cmd_diff(
    cwd: str,
    paths: list[str],
    *,
    staged: bool,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    args = ["diff"]
    if staged:
        args.append("--cached")
    if paths:
        args.extend(["--", *paths])
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    output = stdout.rstrip() or "（无差异）"
    if len(output) > policy_mod._DIFF_OUTPUT_LIMIT:
        output = truncate_head_tail(output, policy_mod._DIFF_OUTPUT_LIMIT)
    return _ok(
        output, start, output_limit=policy_mod._DIFF_OUTPUT_LIMIT, metadata=meta
    )

async def cmd_log(
    cwd: str,
    paths: list[str],
    *,
    max_count: int,
    oneline: bool,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    args = ["log", f"-n{max_count}"]
    if oneline:
        args.append("--oneline")
    if paths:
        args.extend(["--", *paths])
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    lines = [line for line in stdout.splitlines() if line.strip()]
    body = "\n".join(lines) if lines else "（无提交记录）"
    footer = f"\n\n（共 {len(lines)} 条，可用 max_count 调整）"
    return _ok(body + footer, start, metadata=meta)

async def cmd_fetch(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
    context: ToolContext,
) -> ToolResult:
    """Fetch from a named remote — read-only, no approval."""
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
            "（如 git remote add origin <url>）后再 fetch。",
            start,
        )
    if remote not in remotes:
        listed = ", ".join(remotes)
        return _error(
            f"remote '{remote}' 不存在（已配置：{listed}）。",
            start,
        )

    extra = await _cloud_network_extra_env(context)
    stdout, stderr, code = await spawn_mod._run_git(
        ["fetch", remote],
        cwd=cwd,
        timeout=policy_mod._GIT_NETWORK_TIMEOUT,
        extra_env=extra,
        phase=PHASE_REMOTE,
    )
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已从 {remote} fetch"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "remote": remote})

async def cmd_show(
    cwd: str,
    object_ref: str,
    paths: list[str],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    if object_ref.startswith("-"):
        return _error(
            "object 不能以 '-' 开头（防止被 git 解析为选项）",
            start,
        )
    args = ["show", object_ref]
    if paths:
        args.extend(["--", *paths])
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    output = stdout.rstrip() or "（无内容）"
    if len(output) > policy_mod._DIFF_OUTPUT_LIMIT:
        output = truncate_head_tail(output, policy_mod._DIFF_OUTPUT_LIMIT)
    return _ok(
        output,
        start,
        output_limit=policy_mod._DIFF_OUTPUT_LIMIT,
        metadata={**meta, "object": object_ref},
    )

async def cmd_blame(
    cwd: str,
    paths: list[str],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    if not paths:
        return _error("blame 需要 paths 参数（显式单个文件路径）", start)
    if len(paths) != 1:
        return _error("blame 一次只接受一个文件路径", start)
    path = paths[0]
    if path.startswith("-"):
        return _error(
            "blame 路径不能以 '-' 开头（防止被 git 解析为选项）",
            start,
        )
    stdout, stderr, code = await spawn_mod._run_git(["blame", "--", path], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    body = stdout.rstrip() or "（无 blame 输出）"
    body, truncated, total = _truncate_line_output(
        body, limit=policy_mod._BLAME_LINE_LIMIT, hint="请收窄文件范围或分段查看"
    )
    return _ok(
        body,
        start,
        metadata={
            **meta,
            "path": path,
            "truncated": truncated,
            "blame_lines": total,
        },
    )

