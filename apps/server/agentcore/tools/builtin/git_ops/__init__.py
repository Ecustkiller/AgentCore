"""Git operations tool — read and write git state within the workspace.

Thin shell over subprocess git in the workspace root (``ServerWorkspace.root``).
Read subcommands (status / diff / log / fetch / show / blame; stash/tag/remote
``action=list``) run without approval; write subcommands (add / commit / branch /
checkout / push / pull / init_baseline / merge / rebase / cherry-pick /
create_pr; stash push/pop; tag create; remote add) are refused on the CEO path
except ``init_baseline`` (one-shot first baseline; still approval-gated) and
executed on delegated workers (mutating ops require user authorization).
Hard-banned at the breaker (``reset`` / ``clean``); force push /
protected-branch targets stay DENY. Push itself is allowlisted but never force;
``create_pr`` is GitHub-only via API (not free ``gh`` shell); pull is always
``--ff-only``; merge / rebase / cherry-pick stop honestly on conflict (no auto
resolve); main/master current branch is hard-rejected for
commit/push/merge/rebase/cherry-pick; missing remote / credentials fail honestly
(``GIT_TERMINAL_PROMPT=0``).

Timeout contract (aligned with ``terminal``): each subprocess has
``_GIT_TIMEOUT``; the engine wall-clock ceiling is
``serial_ops × _GIT_TIMEOUT + _GIT_KILL_SLACK`` so kill/reap never races the
outer ``asyncio.wait_for``. Status uses a single ``git status -sb`` (branch +
porcelain) to keep serial_ops at 2 for the common read path.

Split axes (implementation modules):
- ``policy`` — allowlists, write detection, argument validators, schema, timeouts
- ``spawn`` — subprocess spawn/reap, auth hints, repo probe
- ``results`` — ToolResult helpers + truncation
- ``cmds_read`` / ``cmds_local`` / ``cmds_remote`` / ``cmds_collab`` — subcommands
- ``tool`` — GitTool registration + dispatch

Public import path stays ``agentcore.tools.builtin.git_ops``.
"""

from agentcore.tools.builtin.git_ops.policy import (
    _ALLOWED_SUBCOMMANDS,
    _ALWAYS_WRITE_SUBCOMMANDS,
    _BLAME_LINE_LIMIT,
    _CEO_ALLOWED_WRITE_SUBCOMMANDS,
    _COLLAB_DANGER_KEYS,
    _DIFF_OUTPUT_LIMIT,
    _FORBIDDEN_PATTERNS,
    _GIT_KILL_SLACK,
    _GIT_TIMEOUT,
    _NETWORK_SUBCOMMANDS,
    _PROTECTED_BRANCHES,
    _STATUS_LINE_LIMIT,
    _WRITE_SUBCOMMANDS,
    GIT_TOOL_PARAMETERS,
    _is_ceo_context,
    _normalize_paths,
    _remote_name_error,
    _validate_add_paths,
    git_call_is_write,
    git_tool_timeout_seconds,
    git_write_subcommands,
)
from agentcore.tools.builtin.git_ops.results import (
    _error,
    _git_failure,
    _ok,
    _truncate_line_output,
    _truncate_status_body,
)
from agentcore.tools.builtin.git_ops.spawn import (
    _AUTH_FAILURE_HINT,
    _AUTH_FAILURE_MARKERS,
    _cloud_network_extra_env,
    _current_branch,
    _ensure_git_repo,
    _git_spawn_kwargs,
    _looks_like_auth_failure,
    _parse_status_sb,
    _reap_git_process,
    _refuse_on_protected_branch,
    _resolve_git_cwd,
    _run_git,
    _workspace_has_local_git,
)
from agentcore.tools.builtin.git_ops.tool import GitTool

__all__ = [
    "GIT_TOOL_PARAMETERS",
    "GitTool",
    "_ALLOWED_SUBCOMMANDS",
    "_ALWAYS_WRITE_SUBCOMMANDS",
    "_AUTH_FAILURE_HINT",
    "_AUTH_FAILURE_MARKERS",
    "_BLAME_LINE_LIMIT",
    "_CEO_ALLOWED_WRITE_SUBCOMMANDS",
    "_COLLAB_DANGER_KEYS",
    "_DIFF_OUTPUT_LIMIT",
    "_FORBIDDEN_PATTERNS",
    "_GIT_KILL_SLACK",
    "_GIT_TIMEOUT",
    "_NETWORK_SUBCOMMANDS",
    "_PROTECTED_BRANCHES",
    "_STATUS_LINE_LIMIT",
    "_WRITE_SUBCOMMANDS",
    "_cloud_network_extra_env",
    "_current_branch",
    "_ensure_git_repo",
    "_error",
    "_git_failure",
    "_git_spawn_kwargs",
    "_is_ceo_context",
    "_looks_like_auth_failure",
    "_normalize_paths",
    "_ok",
    "_parse_status_sb",
    "_reap_git_process",
    "_refuse_on_protected_branch",
    "_remote_name_error",
    "_resolve_git_cwd",
    "_run_git",
    "_truncate_line_output",
    "_truncate_status_body",
    "_validate_add_paths",
    "_workspace_has_local_git",
    "git_call_is_write",
    "git_tool_timeout_seconds",
    "git_write_subcommands",
]
