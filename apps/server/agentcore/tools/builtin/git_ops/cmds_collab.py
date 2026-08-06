"""Collaboration git subcommands: stash / merge / rebase / cherry-pick / tag / remote."""

from __future__ import annotations

from typing import Any

from agentcore.tools.protocol import ToolResult

from . import spawn as spawn_mod
from .policy import (
    _collab_danger_keys_error,
    _name_token_error,
    _ref_token_error,
    _remote_name_error,
    _remote_url_error,
)
from .results import _error, _git_failure, _ok
from .spawn import _refuse_on_protected_branch


async def cmd_stash(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    action = str(arguments.get("action") or "list").strip().lower() or "list"
    if action in {"drop", "clear"}:
        return _error(
            "禁止 stash drop/clear（破坏性清理）。仅允许 list / push / pop。",
            start,
        )
    if action not in {"list", "push", "pop"}:
        return _error(
            f"stash action '{action}' 不支持；仅允许 list / push / pop。",
            start,
        )
    if action == "list":
        stdout, stderr, code = await spawn_mod._run_git(["stash", "list"], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        body = stdout.rstrip() or "（无 stash）"
        return _ok(body, start, metadata={**meta, "action": "list"})

    if action == "push":
        args = ["stash", "push"]
        message = str(arguments.get("message") or "").strip()
        if message:
            if message.startswith("-"):
                return _error(
                    "stash message 不能以 '-' 开头（防止被 git 解析为选项）",
                    start,
                )
            args.extend(["-m", message])
        stdout, stderr, code = await spawn_mod._run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = "已 stash push"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "action": "push"})

    # pop
    stdout, stderr, code = await spawn_mod._run_git(["stash", "pop"], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = "已 stash pop"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "action": "pop"})

async def cmd_merge(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    danger = _collab_danger_keys_error(arguments, label="merge", start=start)
    if danger is not None:
        return danger
    ref = str(arguments.get("ref") or arguments.get("branch") or "").strip()
    ref_err = _ref_token_error(ref, label="merge", start=start)
    if ref_err is not None:
        return ref_err
    protected = await _refuse_on_protected_branch(cwd, label="merge", start=start)
    if protected is not None:
        return protected
    stdout, stderr, code = await spawn_mod._run_git(["merge", "--no-edit", ref], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已合并 {ref}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "ref": ref})

async def cmd_rebase(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    danger = _collab_danger_keys_error(arguments, label="rebase", start=start)
    if danger is not None:
        return danger
    ref = str(arguments.get("ref") or arguments.get("branch") or "").strip()
    ref_err = _ref_token_error(ref, label="rebase", start=start)
    if ref_err is not None:
        return ref_err
    protected = await _refuse_on_protected_branch(cwd, label="rebase", start=start)
    if protected is not None:
        return protected
    stdout, stderr, code = await spawn_mod._run_git(["rebase", ref], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已 rebase 到 {ref}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "ref": ref})

async def cmd_cherry_pick(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    danger = _collab_danger_keys_error(arguments, label="cherry-pick", start=start)
    if danger is not None:
        return danger
    ref = str(
        arguments.get("ref")
        or arguments.get("object")
        or arguments.get("commit")
        or ""
    ).strip()
    ref_err = _ref_token_error(ref, label="cherry-pick", start=start)
    if ref_err is not None:
        return ref_err
    protected = await _refuse_on_protected_branch(
        cwd, label="cherry-pick", start=start
    )
    if protected is not None:
        return protected
    stdout, stderr, code = await spawn_mod._run_git(["cherry-pick", ref], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已 cherry-pick {ref}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "ref": ref})

async def cmd_tag(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    action = str(arguments.get("action") or "list").strip().lower() or "list"
    if action in {"delete", "remove", "rm", "-d"}:
        return _error(
            "禁止删除 tag。仅允许 list / create（轻量标签）。",
            start,
        )
    if action not in {"list", "create"}:
        return _error(
            f"tag action '{action}' 不支持；仅允许 list / create。",
            start,
        )
    if action == "list":
        stdout, stderr, code = await spawn_mod._run_git(["tag", "--list"], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        body = stdout.rstrip() or "（无 tag）"
        return _ok(body, start, metadata={**meta, "action": "list"})

    name = str(arguments.get("name") or "").strip()
    name_err = _name_token_error(name, label="tag create", start=start)
    if name_err is not None:
        return name_err
    # Lightweight tag only — no -a / -m annotated create, no -d delete.
    stdout, stderr, code = await spawn_mod._run_git(["tag", name], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已创建轻量 tag {name}"
    if detail:
        output += f"\n{detail}"
    return _ok(output, start, metadata={**meta, "action": "create", "name": name})

async def cmd_remote(
    cwd: str,
    arguments: dict[str, Any],
    *,
    start: float,
    meta: dict[str, Any],
) -> ToolResult:
    action = str(arguments.get("action") or "list").strip().lower() or "list"
    if action in {"remove", "rm", "delete"}:
        return _error(
            "禁止 remote remove。仅允许 list / add。",
            start,
        )
    if action not in {"list", "add"}:
        return _error(
            f"remote action '{action}' 不支持；仅允许 list / add。",
            start,
        )
    if action == "list":
        stdout, stderr, code = await spawn_mod._run_git(["remote", "-v"], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        body = stdout.rstrip() or "（无 remote）"
        return _ok(body, start, metadata={**meta, "action": "list"})

    name = str(arguments.get("name") or "").strip()
    name_err = _name_token_error(name, label="remote add", start=start)
    if name_err is not None:
        return name_err
    # Reuse remote-name validator (no ':' / whitespace / leading '-').
    remote_err = _remote_name_error(name, start)
    if remote_err is not None:
        return remote_err
    url = str(arguments.get("url") or "").strip()
    url_err = _remote_url_error(url, start)
    if url_err is not None:
        return url_err
    stdout, stderr, code = await spawn_mod._run_git(["remote", "add", name, url], cwd=cwd)
    if code != 0:
        return await _git_failure(stdout, stderr, code, start, metadata=meta)
    detail = (stdout or stderr).strip()
    output = f"已添加 remote {name} → {url}"
    if detail:
        output += f"\n{detail}"
    return _ok(
        output,
        start,
        metadata={**meta, "action": "add", "name": name, "url": url},
    )

