"""GitTool registration + subcommand dispatch."""

from __future__ import annotations

import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    ToolRegistration,
    ToolSurface,
)

from . import cmds_collab, cmds_local, cmds_read, cmds_remote
from .policy import (
    _ALLOWED_SUBCOMMANDS,
    _CEO_ALLOWED_WRITE_SUBCOMMANDS,
    _FORBIDDEN_PATTERNS,
    GIT_TOOL_PARAMETERS,
    _is_ceo_context,
    _normalize_paths,
    git_call_is_write,
)
from .results import _error
from .spawn import _NO_CHANNEL_MSG, _ensure_git_repo, git_transport_scope


class GitTool:
    """Execute git subcommands within the workspace root."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="git",
            description=(
                "工作区根结构化 Git（仅根 `.git`；探路优先 file_list/grep）。"
                "只读免批；写入与 stash push/pop、tag create、remote add 须审批；"
                "CEO 拒写须 delegate（例外 init_baseline 仍须授权）。"
                "无仓：只读→success+no_repo（勿当干净仓）；写硬错；"
                "init_baseline=无仓则 init+首提交，脏仓→dirty_skip。"
                "status 默认无未跟踪；pull=--ff-only；冲突诚实失败；"
                "push/create_pr 恒确认（create_pr 仅 GitHub API）；"
                "force/保护分支/reset|clean/stash drop|clear/删 tag/remote remove 硬拒。"
            ),
            parameters=GIT_TOOL_PARAMETERS,
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
            # Dynamic ceiling via resolve_tool_timeout → git_tool_timeout_seconds.
            timeout_seconds=None,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        subcommand = str(arguments.get("subcommand", "")).strip().lower()
        base_meta = {"subcommand": subcommand} if subcommand else {}

        if not subcommand:
            return _error("subcommand 为必填参数", start)
        if subcommand not in _ALLOWED_SUBCOMMANDS:
            return _error(f"子命令 '{subcommand}' 不在允许列表中", start)
        if any(pattern in subcommand for pattern in _FORBIDDEN_PATTERNS):
            return _error(f"子命令 '{subcommand}' 被安全策略拒绝", start)

        if (
            git_call_is_write(arguments)
            and _is_ceo_context(context)
            and subcommand not in _CEO_ALLOWED_WRITE_SUBCOMMANDS
        ):
            return _error("Git 写入操作需通过 delegate 委派给 Worker 执行。", start)

        with git_transport_scope(context) as cwd:
            if cwd is None:
                return _error(_NO_CHANNEL_MSG, start)

            if subcommand == "init_baseline":
                return await cmds_local.cmd_init_baseline(cwd, start, meta=base_meta)

            is_write = git_call_is_write(arguments)
            # Patchable via spawn._run_git (ensure_repo uses spawn_mod._run_git)
            repo_err = await _ensure_git_repo(cwd, start, write=is_write)
            if repo_err is not None:
                if repo_err.metadata is None:
                    repo_err.metadata = {}
                repo_err.metadata = {**base_meta, **(repo_err.metadata or {})}
                return repo_err

            paths = _normalize_paths(arguments.get("paths"))

            if subcommand == "status":
                include_untracked = bool(arguments.get("include_untracked", False))
                return await cmds_read.cmd_status(
                    cwd, paths, start, include_untracked=include_untracked, meta=base_meta
                )
            if subcommand == "diff":
                staged = bool(arguments.get("staged", False))
                return await cmds_read.cmd_diff(
                    cwd, paths, staged=staged, start=start, meta=base_meta
                )
            if subcommand == "log":
                max_count = int(arguments.get("max_count", 20))
                max_count = max(1, min(max_count, 100))
                oneline = bool(arguments.get("oneline", True))
                return await cmds_read.cmd_log(
                    cwd,
                    paths,
                    max_count=max_count,
                    oneline=oneline,
                    start=start,
                    meta=base_meta,
                )
            if subcommand == "fetch":
                return await cmds_read.cmd_fetch(
                    cwd, arguments, start=start, meta=base_meta, context=context
                )
            if subcommand == "show":
                object_ref = str(arguments.get("object") or "HEAD").strip() or "HEAD"
                return await cmds_read.cmd_show(
                    cwd, object_ref, paths, start=start, meta=base_meta
                )
            if subcommand == "blame":
                return await cmds_read.cmd_blame(cwd, paths, start=start, meta=base_meta)
            if subcommand == "add":
                return await cmds_local.cmd_add(cwd, paths, start, meta=base_meta)
            if subcommand == "commit":
                message = str(arguments.get("message", "")).strip()
                return await cmds_local.cmd_commit(cwd, message, start, meta=base_meta)
            if subcommand == "branch":
                branch = str(arguments.get("branch", "")).strip()
                return await cmds_local.cmd_branch(cwd, branch, start, meta=base_meta)
            if subcommand == "checkout":
                branch = str(arguments.get("branch", "")).strip()
                create = bool(arguments.get("create", False))
                return await cmds_local.cmd_checkout(
                    cwd, branch, create=create, start=start, meta=base_meta
                )
            if subcommand == "push":
                return await cmds_remote.cmd_push(
                    cwd,
                    arguments,
                    start=start,
                    meta=base_meta,
                    context=context,
                )
            if subcommand == "pull":
                return await cmds_remote.cmd_pull(
                    cwd,
                    arguments,
                    start=start,
                    meta=base_meta,
                    context=context,
                )
            if subcommand == "stash":
                return await cmds_collab.cmd_stash(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "merge":
                return await cmds_collab.cmd_merge(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "rebase":
                return await cmds_collab.cmd_rebase(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "cherry-pick":
                return await cmds_collab.cmd_cherry_pick(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "tag":
                return await cmds_collab.cmd_tag(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "remote":
                return await cmds_collab.cmd_remote(
                    cwd, arguments, start=start, meta=base_meta
                )
            if subcommand == "create_pr":
                return await cmds_remote.cmd_create_pr(
                    cwd,
                    arguments,
                    start=start,
                    meta=base_meta,
                    context=context,
                )

            return _error(f"子命令 '{subcommand}' 不在允许列表中", start)
