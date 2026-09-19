"""Read-only git subcommands: status / diff / log / fetch."""

from __future__ import annotations

from typing import Any

from agentcore.core.text import truncate_head_tail
from agentcore.tools.protocol import ToolContext, ToolResult

from . import policy as policy_mod
from . import spawn as spawn_mod
from .phases import PHASE_REMOTE
from .policy import GIT_LOG_MAX_COUNT, GIT_REMOTE
from .results import _error, _git_failure, _ok, _truncate_line_output
from .spawn import _cloud_network_extra_env, _parse_status_sb


async def cmd_status(
    cwd: str,
    paths: list[str],
    start: float,
    *,
    meta: dict[str, Any],
) -> ToolResult:
    # Single subprocess: branch header + porcelain (avoids branch + status serial).
    # Untracked files are always listed; leftover include_untracked is ignored.
    args = ["status", "-sb"]
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
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    args = ["log", f"-n{GIT_LOG_MAX_COUNT}", "--oneline"]
    if paths:
        args.extend(["--", *paths])
    stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    lines = [line for line in stdout.splitlines() if line.strip()]
    body = "\n".join(lines) if lines else "（无提交记录）"
    footer = f"\n\n（共 {len(lines)} 条）"
    return _ok(body + footer, start, metadata=meta)


async def cmd_fetch(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
    context: ToolContext,
) -> ToolResult:
    """Fetch from origin — read-only, no approval."""
    _ = arguments
    remote = GIT_REMOTE

    remotes_out, remotes_err, remotes_code = await spawn_mod._run_git(["remote"], cwd=cwd)
    if remotes_code != 0:
        detail = (remotes_err or remotes_out or "无法列出 remote").strip()
        return _error(detail, start)
    remotes = [line.strip() for line in remotes_out.splitlines() if line.strip()]
    if not remotes:
        return _error(
            "当前仓库未配置 remote。请用户添加 origin 后再 fetch。",
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
