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
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from agentcore.core.text import truncate_head_tail
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.safety_breaker import (
    git_forbidden_subcommands,
    git_protected_branches,
)
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    ToolRegistration,
    ToolSurface,
)

_ALLOWED_SUBCOMMANDS = frozenset(
    {
        "status",
        "diff",
        "log",
        "fetch",
        "show",
        "blame",
        "add",
        "commit",
        "branch",
        "checkout",
        "push",
        "pull",
        "init_baseline",
        "stash",
        "merge",
        "rebase",
        "cherry-pick",
        "tag",
        "remote",
        "create_pr",
    }
)
# Always-mutating verbs (approval + CEO ban + write ensure_repo).
_ALWAYS_WRITE_SUBCOMMANDS = frozenset(
    {
        "add",
        "commit",
        "branch",
        "checkout",
        "push",
        "pull",
        "init_baseline",
        "merge",
        "rebase",
        "cherry-pick",
        "create_pr",
    }
)
# Action-gated verbs: only listed actions mutate; ``list`` is read-only / no approval.
_ACTION_WRITE_MAP: dict[str, frozenset[str]] = {
    "stash": frozenset({"push", "pop"}),
    "tag": frozenset({"create"}),
    "remote": frozenset({"add"}),
}
_WRITE_SUBCOMMANDS = _ALWAYS_WRITE_SUBCOMMANDS | frozenset(_ACTION_WRITE_MAP)
# CEO may run this one write: one-shot「初始化并首提交」(user still approves via gate).
_CEO_ALLOWED_WRITE_SUBCOMMANDS = frozenset({"init_baseline"})
_NO_REPO_CODE = "no_repo"
_DIRTY_SKIP_CODE = "dirty_skip"
_ALREADY_REPO_CODE = "already_repo"
_INIT_BASELINE_MESSAGE = "Initial commit (AgentCore baseline)"
_INIT_BASELINE_AUTHOR_NAME = "AgentCore"
_INIT_BASELINE_AUTHOR_EMAIL = "agentcore@local"
# Strategy / force knobs rejected on merge / rebase / cherry-pick before argv.
_COLLAB_DANGER_KEYS = frozenset(
    {
        "force",
        "force_with_lease",
        "forceWithLease",
        "hard",
        "interactive",
        "autosquash",
        "strategy",
        "strategy_option",
        "strategyOption",
        "no_ff",
        "no-ff",
        "ff_only",
        "ff-only",
        "squash",
        "continue",
        "abort",
        "skip",
        "onto",
        "root",
        "mainline",
        "no_commit",
        "no-commit",
        "signoff",
    }
)


def git_write_subcommands() -> frozenset[str]:
    """Git subcommand names that *can* mutate (membership); prefer ``git_call_is_write``."""
    return _WRITE_SUBCOMMANDS


def git_call_is_write(arguments: dict[str, Any] | None = None) -> bool:
    """Whether this git tool call mutates repo state (approval / CEO / ensure_repo)."""
    args = arguments or {}
    sub = str(args.get("subcommand", "")).strip().lower()
    if sub in _ALWAYS_WRITE_SUBCOMMANDS:
        return True
    allowed_actions = _ACTION_WRITE_MAP.get(sub)
    if allowed_actions is None:
        return False
    action = str(args.get("action") or "list").strip().lower() or "list"
    return action in allowed_actions


# Hard-ban list lives in ``runtime.safety_breaker`` (P3 unified circuit breaker).
_FORBIDDEN_PATTERNS = git_forbidden_subcommands()
_PROTECTED_BRANCHES = git_protected_branches()
_DIFF_OUTPUT_LIMIT = 16000
_STATUS_LINE_LIMIT = 200
# blame is line-oriented; reuse status porcelain line budget.
_BLAME_LINE_LIMIT = _STATUS_LINE_LIMIT
# Per-subprocess ceiling. Engine outer = serial_ops × this + kill slack.
_GIT_TIMEOUT = 20.0
_GIT_KILL_SLACK = 5.0
_NETWORK_SUBCOMMANDS = frozenset({"push", "pull", "fetch", "create_pr"})


def git_tool_timeout_seconds(arguments: dict[str, Any] | None = None) -> float:
    """Engine wall-clock ceiling for one ``git`` tool call (must outlive inner ops).

    ``ensure_repo`` + primary command = 2; ``commit`` also probes branch and short SHA;
    ``push``/``pull``/``fetch``/``create_pr``: ensure_repo + remotes + network op
    (inner up to 60s) — outer must stay above the sum of bounded subprocesses.
    """
    sub = str((arguments or {}).get("subcommand", "")).strip().lower()
    if sub in _NETWORK_SUBCOMMANDS:
        # ensure_repo (~2×20) + remote list (20) + network op (60) + slack
        return 2 * _GIT_TIMEOUT + _GIT_TIMEOUT + 60.0 + _GIT_KILL_SLACK
    if sub == "init_baseline":
        # init + add -A + commit (+ optional status probe when already a repo)
        return 4 * _GIT_TIMEOUT + _GIT_KILL_SLACK
    serial = 4 if sub == "commit" else 2
    return serial * _GIT_TIMEOUT + _GIT_KILL_SLACK


GIT_TOOL_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subcommand": {
            "type": "string",
            "enum": [
                "status",
                "diff",
                "log",
                "fetch",
                "show",
                "blame",
                "add",
                "commit",
                "branch",
                "checkout",
                "push",
                "pull",
                "init_baseline",
                "stash",
                "merge",
                "rebase",
                "cherry-pick",
                "tag",
                "remote",
                "create_pr",
            ],
            "description": (
                "要执行的 git 子命令。"
                "只读 status/diff/log/fetch/show/blame：需工作区根 `.git`（不扫嵌套、不上溯）；"
                "无仓 → success + metadata.code=no_repo。"
                "stash/tag/remote 的 action=list 只读免批；push/pop、create、add 须审批。"
                "写入 add/commit/branch/checkout/push/pull/merge/rebase/cherry-pick/create_pr："
                "无仓仍硬错；需用户授权；CEO 路径拒写（须 delegate）。"
                "例外 init_baseline：无仓时初始化并首提交（一键基线；CEO 可调、仍需授权）；"
                "已有仓且工作区脏 → 不代 commit（metadata.code=dirty_skip）。"
                "pull 固定 --ff-only；merge/rebase/cherry-pick 冲突诚实失败，不自动 resolve。"
                "push / create_pr 需用户授权（恒确认）；create_pr 仅 GitHub（API，非自由 shell）；"
                "force / 保护分支仍拒；reset/clean 硬禁；无凭据会失败。"
            ),
        },
        "paths": {
            "type": "array",
            "items": {"type": "string"},
            "description": (
                "status/diff/add/show/blame 的路径过滤（工作区相对路径）。"
                "add 时必填；blame 时必填且仅一个文件。"
                "大仓 status/diff 请尽量收窄 paths，避免全树扫描超时。"
            ),
        },
        "staged": {
            "type": "boolean",
            "description": "diff 时只看暂存区（等同 git diff --cached）。默认 false。",
            "default": False,
        },
        "include_untracked": {
            "type": "boolean",
            "description": (
                "status 是否包含未跟踪文件。默认 false（--untracked-files=no），"
                "大仓更快；需要看未跟踪时显式传 true。"
            ),
            "default": False,
        },
        "max_count": {
            "type": "integer",
            "description": "log 最多返回条数（默认 20，上限 100）。",
            "default": 20,
        },
        "oneline": {
            "type": "boolean",
            "description": "log 使用 --oneline 格式。默认 true。",
            "default": True,
        },
        "message": {
            "type": "string",
            "description": (
                "commit 的提交说明（subcommand=commit 时必填）；"
                "stash push 可选说明。"
            ),
        },
        "branch": {
            "type": "string",
            "description": "branch/checkout 的分支名（subcommand=branch 或 checkout 时必填）。",
        },
        "create": {
            "type": "boolean",
            "description": "checkout 时创建新分支（-b）。默认 false。",
            "default": False,
        },
        "remote": {
            "type": "string",
            "description": (
                "fetch/pull/push 的远程名（默认 origin）。仅远程名，禁止 refspec / 选项形态。"
            ),
            "default": "origin",
        },
        "set_upstream": {
            "type": "boolean",
            "description": "push 时设置上游跟踪（--set-upstream）。默认 false。",
            "default": False,
        },
        "object": {
            "type": "string",
            "description": (
                "show 的对象（提交 / 树 / blob，默认 HEAD）。禁止以 '-' 开头的选项形态。"
            ),
            "default": "HEAD",
        },
        "action": {
            "type": "string",
            "enum": ["list", "push", "pop", "create", "add"],
            "description": (
                "stash：list（只读免批）/ push / pop（须审批）；禁止 drop/clear。"
                "tag：list（只读）/ create（须审批）；禁止删 tag。"
                "remote：list（只读，等同 -v）/ add（须审批）；禁止 remove。"
                "默认 list。"
            ),
            "default": "list",
        },
        "ref": {
            "type": "string",
            "description": (
                "merge / rebase / cherry-pick 的目标引用（分支名或 commit SHA）。"
                "禁止以 '-' 开头的选项形态。"
            ),
        },
        "name": {
            "type": "string",
            "description": (
                "tag create 的标签名；remote add 的远程名。"
                "禁止以 '-' 开头。"
            ),
        },
        "url": {
            "type": "string",
            "description": (
                "remote add 的 URL 或本地路径（http(s)/ssh/git/file 或路径）。"
                "禁止以 '-' 开头的选项形态。"
            ),
        },
        "title": {
            "type": "string",
            "description": "create_pr 的 PR 标题（必填）。",
        },
        "body": {
            "type": "string",
            "description": "create_pr 的 PR 正文（可选，默认空）。",
            "default": "",
        },
        "base": {
            "type": "string",
            "description": (
                "create_pr 的目标分支（可选；默认仓库 default_branch，如 main）。"
            ),
        },
        "head": {
            "type": "string",
            "description": (
                "create_pr 的源分支（可选；默认当前分支）。须已推到 GitHub remote。"
            ),
        },
    },
    "required": ["subcommand"],
}


def _error(error: str, start: float, **kwargs: Any) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
        **kwargs,
    )


def _ok(output: str, start: float, **kwargs: Any) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        success=True,
        output=output,
        duration_ms=int((time.monotonic() - start) * 1000),
        **kwargs,
    )


def _resolve_git_cwd(context: ToolContext) -> str | None:
    """Return the absolute workspace root for git, when available."""
    root = getattr(context.backend, "root", None)
    if root is not None:
        # Always absolute so GIT_CEILING_DIRECTORIES matches the process cwd.
        return str(Path(root).resolve())
    return None


def _workspace_has_local_git(cwd: str) -> bool:
    """True only when ``.git`` exists *inside* the workspace root (no parent climb)."""
    return (Path(cwd) / ".git").exists()


def _is_ceo_context(context: ToolContext) -> bool:
    """CEO turns carry no worker-only coordination channels."""
    return (
        context.write_coordinator is None
        and context.note_wall is None
        and context.escalation is None
    )


def _git_spawn_kwargs() -> dict[str, Any]:
    """POSIX: new session so timeout can ``killpg`` the whole tree (sandbox pattern)."""
    return {} if sys.platform == "win32" else {"start_new_session": True}


async def _reap_git_process(proc: asyncio.subprocess.Process) -> None:
    """Kill the git child and descendants, then reap (best-effort, never raises)."""
    if proc.returncode is not None:
        return
    pid = proc.pid
    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            await asyncio.to_thread(
                subprocess.run,
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
    else:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(pid, signal.SIGKILL)
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
    with contextlib.suppress(Exception):
        await asyncio.wait_for(proc.wait(), timeout=5.0)


_AUTH_FAILURE_MARKERS = (
    "authentication failed",
    "could not read username",
    "invalid username or password",
    "access denied",
    "permission denied (publickey)",
    "authentication required",
    "fatal: could not read",
    "http basic: access denied",
    "repository not found",
    "the requested url returned error: 401",
    "the requested url returned error: 403",
    "terminal prompts disabled",
)

_AUTH_FAILURE_HINT = (
    "需要凭据：请到「设置 → Git 凭据」配置账户级 PAT（云工作区私仓），"
    "或打开已配置 OS credential helper / gh auth 的本地仓库后再试。"
)


def _looks_like_auth_failure(blob: str) -> bool:
    lower = blob.lower()
    return any(m in lower for m in _AUTH_FAILURE_MARKERS)


def _is_cloud_backend(context: ToolContext) -> bool:
    """Cloud ServerWorkspace only — Local inherits OS / gh auth, do not inject PAT."""
    return getattr(context.backend, "location", None) == "server"


async def _cloud_network_extra_env(context: ToolContext) -> dict[str, str] | None:
    """Credential helper env for cloud push/fetch/pull when an account PAT exists."""
    if not _is_cloud_backend(context) or not context.user_id:
        return None
    from agentcore.workspace.git_credentials import load_git_auth_for_user

    auth = await load_git_auth_for_user(context.user_id)
    if auth is None:
        return None
    # Inline credential helper via GIT_CONFIG_* (no disk write of the token).
    helper = (
        f'!f() {{ echo "username={auth.username}"; echo "password={auth.token}"; }}; f'
    )
    return {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "credential.helper",
        "GIT_CONFIG_VALUE_0": helper,
    }


async def _run_git(
    args: list[str],
    *,
    cwd: str,
    timeout: float = _GIT_TIMEOUT,
    extra_env: dict[str, str] | None = None,
) -> tuple[str, str, int]:
    """Run git command, return (stdout, stderr, exit_code).

    ``GIT_CEILING_DIRECTORIES`` is set to the workspace root so discovery never
    climbs into a parent repo (e.g. workspace nested under the host monorepo).
    On timeout / cancel, reaps the process tree (Windows ``taskkill /T``).
    """
    ceiling = str(Path(cwd).resolve())
    env = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CEILING_DIRECTORIES": ceiling,
    }
    if extra_env:
        env.update(extra_env)
    proc = await asyncio.create_subprocess_exec(
        "git",
        *args,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        **_git_spawn_kwargs(),
    )
    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        await _reap_git_process(proc)
        return "", f"git 操作超时（{' '.join(args)}）", 1
    except asyncio.CancelledError:
        await _reap_git_process(proc)
        raise
    return (
        stdout_b.decode("utf-8", errors="replace"),
        stderr_b.decode("utf-8", errors="replace"),
        proc.returncode or 0,
    )


async def _git_failure(
    stdout: str, stderr: str, exit_code: int, start: float, **kwargs: Any
) -> ToolResult:
    detail = (stderr or stdout or f"git 退出码 {exit_code}").strip()
    meta = dict(kwargs.pop("metadata", {}) or {})
    if "超时" in detail:
        meta.setdefault("timeout_layer", "inner")
    blob = f"{stderr}\n{stdout}"
    lower = blob.lower()
    if (
        "conflict" in lower
        or "合并冲突" in blob
        or "自动合并失败" in blob
        or "fix conflicts" in lower
        or "could not apply" in lower
        or "needs merge" in lower
    ):
        meta.setdefault("conflict", True)
        if "不自动" not in detail and "自动 resolve" not in detail:
            detail = (
                f"{detail}\n"
                "（检测到冲突：已诚实停止，不会自动 resolve；请人工处理后再继续。）"
            )
    if _looks_like_auth_failure(blob) and _AUTH_FAILURE_HINT not in detail:
        detail = f"{detail}\n{_AUTH_FAILURE_HINT}"
    return _error(detail, start, metadata=meta, **kwargs)


def _ref_token_error(ref: str, *, label: str, start: float) -> ToolResult | None:
    """Reject empty / option-like refs before they reach argv."""
    if not ref:
        return _error(f"{label} 需要 ref 参数（分支名或 commit）", start)
    if ref.startswith("-"):
        return _error(
            f"{label} 的 ref 不能以 '-' 开头（防止被 git 解析为选项）",
            start,
        )
    if any(ch.isspace() for ch in ref):
        return _error(f"{label} 的 ref 不能包含空白", start)
    return None


def _collab_danger_keys_error(
    arguments: dict[str, Any], *, label: str, start: float
) -> ToolResult | None:
    hit = sorted(k for k in arguments if k in _COLLAB_DANGER_KEYS)
    if not hit:
        return None
    return _error(
        f"{label} 禁止危险/策略旋钮（{', '.join(hit)}）；"
        "冲突时诚实失败，不自动 resolve，不支持 --force 类参数。",
        start,
    )


def _name_token_error(name: str, *, label: str, start: float) -> ToolResult | None:
    if not name:
        return _error(f"{label} 需要 name 参数", start)
    if name.startswith("-"):
        return _error(
            f"{label} 的 name 不能以 '-' 开头（防止被 git 解析为选项）",
            start,
        )
    if any(ch.isspace() for ch in name) or ":" in name:
        return _error(f"{label} 的 name 不能包含空白或 ':'", start)
    return None


def _remote_url_error(url: str, start: float) -> ToolResult | None:
    if not url:
        return _error("remote add 需要 url 参数", start)
    if url.startswith("-"):
        return _error(
            "remote url 不能以 '-' 开头（防止被 git 解析为选项）",
            start,
        )
    if any(ch.isspace() for ch in url):
        return _error("remote url 不能包含空白", start)
    return None


async def _refuse_on_protected_branch(
    cwd: str, *, label: str, start: float
) -> ToolResult | None:
    branch = await _current_branch(cwd)
    if branch in _PROTECTED_BRANCHES:
        return _error(
            f"禁止在 main/master 上直接 {label}，请先 checkout 到功能分支",
            start,
        )
    return None


_NO_LOCAL_REPO_MSG = (
    "当前工作区内没有 Git 仓库（仅识别工作区根下的 .git；不会上溯到父目录仓库）"
)


def _no_repo_ok(start: float) -> ToolResult:
    """Read-only no-repo: success with machine-readable code (never fake a clean tree)."""
    return _ok(
        _NO_LOCAL_REPO_MSG,
        start,
        metadata={"code": _NO_REPO_CODE},
    )


async def _ensure_git_repo(
    cwd: str, start: float, *, write: bool
) -> ToolResult | None:
    # Fast path: refuse before any git discovery that could surface a parent repo.
    if not _workspace_has_local_git(cwd):
        if write:
            return _error(_NO_LOCAL_REPO_MSG, start)
        return _no_repo_ok(start)
    stdout, stderr, code = await _run_git(
        ["rev-parse", "--is-inside-work-tree"], cwd=cwd
    )
    if code != 0 or stdout.strip() != "true":
        detail = (stderr or stdout or _NO_LOCAL_REPO_MSG).strip()
        if write:
            return _error(detail, start)
        return _ok(detail, start, metadata={"code": _NO_REPO_CODE})
    return None


async def _current_branch(cwd: str) -> str:
    stdout, _, code = await _run_git(["branch", "--show-current"], cwd=cwd)
    if code != 0:
        return ""
    return stdout.strip()


def _parse_status_sb(stdout: str) -> tuple[str, str]:
    """Parse ``git status -sb`` into (branch_line, body)."""
    lines = stdout.splitlines()
    if not lines:
        return "(无)", ""
    first = lines[0]
    if first.startswith("## "):
        # ``## main...origin/main [ahead 1]`` → branch token before ``...`` / space.
        rest = first[3:].strip()
        branch = rest.split("...", 1)[0].split(" ", 1)[0].strip() or "(无)"
        body = "\n".join(lines[1:]).rstrip()
        return branch, body
    return "(无)", stdout.rstrip()


def _truncate_line_output(
    body: str, *, limit: int, hint: str
) -> tuple[str, bool, int]:
    """Cap line-oriented output; return (text, truncated, total_lines)."""
    if not body:
        return "", False, 0
    lines = body.splitlines()
    total = len(lines)
    if total <= limit:
        return body, False, total
    kept = "\n".join(lines[:limit])
    kept += f"\n…（已截断，共 {total} 行，仅显示前 {limit} 行；{hint}）"
    return kept, True, total


def _truncate_status_body(body: str) -> tuple[str, bool, int]:
    """Cap status porcelain lines; return (text, truncated, total_lines)."""
    return _truncate_line_output(
        body, limit=_STATUS_LINE_LIMIT, hint="请用 paths 收窄范围"
    )


def _validate_add_paths(paths: list[Any], start: float) -> ToolResult | None:
    if not paths:
        return _error("add 需要显式 paths 参数，禁止使用 git add . / -A / --all", start)
    forbidden = {".", "-A", "--all"}
    for raw in paths:
        path = str(raw).strip()
        if not path:
            return _error("add 的 paths 不能包含空路径", start)
        if path in forbidden:
            return _error(
                f"禁止 add 路径 '{path}'：请显式列出文件，不要使用 . / -A / --all",
                start,
            )
        if "*" in path or "?" in path:
            return _error(f"禁止 add 通配符路径 '{path}'：请显式列出文件", start)
    return None


def _normalize_paths(raw_paths: Any) -> list[str]:
    if not raw_paths:
        return []
    return [str(p) for p in raw_paths if str(p).strip()]


def _remote_name_error(remote: str, start: float) -> ToolResult | None:
    """Reject option-like / refspec remote tokens before they reach argv."""
    if remote.startswith("-"):
        return _error("remote 名不能以 '-' 开头（防止被 git 解析为选项）", start)
    if ":" in remote or any(ch.isspace() for ch in remote):
        return _error(
            "remote 仅允许远程名（默认 origin），禁止 refspec 或空白",
            start,
        )
    return None


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
                "在工作区内执行 Git 操作。根规则：仅工作区根 `.git`"
                "（不扫嵌套、不上溯）。探路摸底优先 file_list/grep。"
                "只读：status / diff / log / fetch / show / blame；"
                "stash/tag/remote 的 action=list"
                "（无仓 → success + metadata.code=no_repo，禁止当成干净仓；"
                "status 默认不含未跟踪文件；show/blame 输出有界截断）。"
                "写入（需用户授权）：add / commit / branch / checkout / push / pull /"
                "merge / rebase / cherry-pick / create_pr；stash push/pop；tag create；"
                "remote add（无仓仍硬错；CEO 拒写须 delegate）。"
                "pull 固定 --ff-only；merge/rebase/cherry-pick 冲突诚实失败。"
                "一键基线：init_baseline（无仓→init+首提交；CEO 可调仍需授权；"
                "已有仓且脏树不代 commit）。"
                "push / create_pr 需授权（恒确认）；create_pr 仅 GitHub API；"
                "force / 保护分支仍拒；无凭据会失败（指向设置凭据 / 本地仓）。"
                "reset / clean 硬禁；stash drop/clear、删 tag、remote remove 硬拒。"
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

        cwd = _resolve_git_cwd(context)
        if cwd is None:
            return _error("当前工作区模式不支持 Git 操作（无本地根目录）", start)

        if subcommand == "init_baseline":
            return await self._cmd_init_baseline(cwd, start, meta=base_meta)

        is_write = git_call_is_write(arguments)
        repo_err = await _ensure_git_repo(cwd, start, write=is_write)
        if repo_err is not None:
            if repo_err.metadata is None:
                repo_err.metadata = {}
            repo_err.metadata = {**base_meta, **(repo_err.metadata or {})}
            return repo_err

        paths = _normalize_paths(arguments.get("paths"))

        if subcommand == "status":
            include_untracked = bool(arguments.get("include_untracked", False))
            return await self._cmd_status(
                cwd, paths, start, include_untracked=include_untracked, meta=base_meta
            )
        if subcommand == "diff":
            staged = bool(arguments.get("staged", False))
            return await self._cmd_diff(
                cwd, paths, staged=staged, start=start, meta=base_meta
            )
        if subcommand == "log":
            max_count = int(arguments.get("max_count", 20))
            max_count = max(1, min(max_count, 100))
            oneline = bool(arguments.get("oneline", True))
            return await self._cmd_log(
                cwd,
                paths,
                max_count=max_count,
                oneline=oneline,
                start=start,
                meta=base_meta,
            )
        if subcommand == "fetch":
            return await self._cmd_fetch(
                cwd, arguments, start=start, meta=base_meta, context=context
            )
        if subcommand == "show":
            object_ref = str(arguments.get("object") or "HEAD").strip() or "HEAD"
            return await self._cmd_show(
                cwd, object_ref, paths, start=start, meta=base_meta
            )
        if subcommand == "blame":
            return await self._cmd_blame(cwd, paths, start=start, meta=base_meta)
        if subcommand == "add":
            return await self._cmd_add(cwd, paths, start, meta=base_meta)
        if subcommand == "commit":
            message = str(arguments.get("message", "")).strip()
            return await self._cmd_commit(cwd, message, start, meta=base_meta)
        if subcommand == "branch":
            branch = str(arguments.get("branch", "")).strip()
            return await self._cmd_branch(cwd, branch, start, meta=base_meta)
        if subcommand == "checkout":
            branch = str(arguments.get("branch", "")).strip()
            create = bool(arguments.get("create", False))
            return await self._cmd_checkout(
                cwd, branch, create=create, start=start, meta=base_meta
            )
        if subcommand == "push":
            return await self._cmd_push(
                cwd,
                arguments,
                start=start,
                meta=base_meta,
                context=context,
            )
        if subcommand == "pull":
            return await self._cmd_pull(
                cwd,
                arguments,
                start=start,
                meta=base_meta,
                context=context,
            )
        if subcommand == "stash":
            return await self._cmd_stash(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "merge":
            return await self._cmd_merge(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "rebase":
            return await self._cmd_rebase(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "cherry-pick":
            return await self._cmd_cherry_pick(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "tag":
            return await self._cmd_tag(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "remote":
            return await self._cmd_remote(
                cwd, arguments, start=start, meta=base_meta
            )
        if subcommand == "create_pr":
            return await self._cmd_create_pr(
                cwd,
                arguments,
                start=start,
                meta=base_meta,
                context=context,
            )

        return _error(f"子命令 '{subcommand}' 不在允许列表中", start)

    async def _cmd_init_baseline(
        self,
        cwd: str,
        start: float,
        *,
        meta: dict[str, Any],
    ) -> ToolResult:
        """Init repo + first commit when missing; never force-commit a dirty existing tree."""
        if _workspace_has_local_git(cwd):
            porcelain, stderr, code = await _run_git(
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

        init_out, init_err, init_code = await _run_git(["init"], cwd=cwd)
        if init_code != 0:
            return await _git_failure(init_out, init_err, init_code, start, metadata=meta)

        add_out, add_err, add_code = await _run_git(["add", "-A"], cwd=cwd)
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
        commit_out, commit_err, commit_code = await _run_git(commit_args, cwd=cwd)
        if commit_code != 0:
            return await _git_failure(
                commit_out, commit_err, commit_code, start, metadata=meta
            )

        sha, _, sha_code = await _run_git(["rev-parse", "--short", "HEAD"], cwd=cwd)
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

    async def _cmd_status(
        self,
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
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        branch, body = _parse_status_sb(stdout)
        body, truncated, total = _truncate_line_output(
            body, limit=_STATUS_LINE_LIMIT, hint="请用 paths 收窄范围"
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

    async def _cmd_diff(
        self,
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
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        output = stdout.rstrip() or "（无差异）"
        if len(output) > _DIFF_OUTPUT_LIMIT:
            output = truncate_head_tail(output, _DIFF_OUTPUT_LIMIT)
        return _ok(
            output, start, output_limit=_DIFF_OUTPUT_LIMIT, metadata=meta
        )

    async def _cmd_log(
        self,
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
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        lines = [line for line in stdout.splitlines() if line.strip()]
        body = "\n".join(lines) if lines else "（无提交记录）"
        footer = f"\n\n（共 {len(lines)} 条，可用 max_count 调整）"
        return _ok(body + footer, start, metadata=meta)

    async def _cmd_fetch(
        self,
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

        remotes_out, remotes_err, remotes_code = await _run_git(["remote"], cwd=cwd)
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
        stdout, stderr, code = await _run_git(
            ["fetch", remote], cwd=cwd, timeout=60.0, extra_env=extra
        )
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已从 {remote} fetch"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "remote": remote})

    async def _cmd_show(
        self,
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
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        output = stdout.rstrip() or "（无内容）"
        if len(output) > _DIFF_OUTPUT_LIMIT:
            output = truncate_head_tail(output, _DIFF_OUTPUT_LIMIT)
        return _ok(
            output,
            start,
            output_limit=_DIFF_OUTPUT_LIMIT,
            metadata={**meta, "object": object_ref},
        )

    async def _cmd_blame(
        self,
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
        stdout, stderr, code = await _run_git(["blame", "--", path], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        body = stdout.rstrip() or "（无 blame 输出）"
        body, truncated, total = _truncate_line_output(
            body, limit=_BLAME_LINE_LIMIT, hint="请收窄文件范围或分段查看"
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

    async def _cmd_add(
        self, cwd: str, paths: list[str], start: float, *, meta: dict[str, Any]
    ) -> ToolResult:
        path_err = _validate_add_paths(paths, start)
        if path_err is not None:
            return path_err
        args = ["add", "--", *paths]
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        listed = ", ".join(paths)
        detail = (stdout or stderr).strip()
        output = f"已暂存：{listed}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata=meta)

    async def _cmd_commit(
        self, cwd: str, message: str, start: float, *, meta: dict[str, Any]
    ) -> ToolResult:
        if not message:
            return _error("commit 需要 message 参数", start)
        branch = await _current_branch(cwd)
        if branch in _PROTECTED_BRANCHES:
            return _error(
                "禁止在 main/master 分支直接提交，请先 checkout 到功能分支",
                start,
            )
        stdout, stderr, code = await _run_git(["commit", "-m", message], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        sha, _, sha_code = await _run_git(["rev-parse", "--short", "HEAD"], cwd=cwd)
        short_sha = sha.strip() if sha_code == 0 else ""
        output = f"已提交 {short_sha}：{message}" if short_sha else f"已提交：{message}"
        detail = (stdout or stderr).strip()
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata=meta)

    async def _cmd_branch(
        self, cwd: str, branch: str, start: float, *, meta: dict[str, Any]
    ) -> ToolResult:
        if not branch:
            return _error("branch 需要 branch 参数", start)
        if branch.startswith("-"):
            return _error("分支名不能以 '-' 开头（防止被 git 解析为选项）", start)
        stdout, stderr, code = await _run_git(["branch", branch], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已创建分支 {branch}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata=meta)

    async def _cmd_checkout(
        self,
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
        stdout, stderr, code = await _run_git(args, cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        action = "已创建并切换到分支" if create else "已切换到分支"
        detail = (stdout or stderr).strip()
        output = f"{action} {branch}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata=meta)

    async def _cmd_push(
        self,
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

        remotes_out, remotes_err, remotes_code = await _run_git(["remote"], cwd=cwd)
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
        stdout, stderr, code = await _run_git(
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

    async def _cmd_pull(
        self,
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

        remotes_out, remotes_err, remotes_code = await _run_git(["remote"], cwd=cwd)
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
        stdout, stderr, code = await _run_git(
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

    async def _cmd_stash(
        self,
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
            stdout, stderr, code = await _run_git(["stash", "list"], cwd=cwd)
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
            stdout, stderr, code = await _run_git(args, cwd=cwd)
            if code != 0:
                return await _git_failure(stdout, stderr, code, start, metadata=meta)
            detail = (stdout or stderr).strip()
            output = "已 stash push"
            if detail:
                output += f"\n{detail}"
            return _ok(output, start, metadata={**meta, "action": "push"})

        # pop
        stdout, stderr, code = await _run_git(["stash", "pop"], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = "已 stash pop"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "action": "pop"})

    async def _cmd_merge(
        self,
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
        stdout, stderr, code = await _run_git(["merge", "--no-edit", ref], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已合并 {ref}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "ref": ref})

    async def _cmd_rebase(
        self,
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
        stdout, stderr, code = await _run_git(["rebase", ref], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已 rebase 到 {ref}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "ref": ref})

    async def _cmd_cherry_pick(
        self,
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
        stdout, stderr, code = await _run_git(["cherry-pick", ref], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已 cherry-pick {ref}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "ref": ref})

    async def _cmd_tag(
        self,
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
            stdout, stderr, code = await _run_git(["tag", "--list"], cwd=cwd)
            if code != 0:
                return await _git_failure(stdout, stderr, code, start, metadata=meta)
            body = stdout.rstrip() or "（无 tag）"
            return _ok(body, start, metadata={**meta, "action": "list"})

        name = str(arguments.get("name") or "").strip()
        name_err = _name_token_error(name, label="tag create", start=start)
        if name_err is not None:
            return name_err
        # Lightweight tag only — no -a / -m annotated create, no -d delete.
        stdout, stderr, code = await _run_git(["tag", name], cwd=cwd)
        if code != 0:
            return await _git_failure(stdout, stderr, code, start, metadata=meta)
        detail = (stdout or stderr).strip()
        output = f"已创建轻量 tag {name}"
        if detail:
            output += f"\n{detail}"
        return _ok(output, start, metadata={**meta, "action": "create", "name": name})

    async def _cmd_remote(
        self,
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
            stdout, stderr, code = await _run_git(["remote", "-v"], cwd=cwd)
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
        stdout, stderr, code = await _run_git(["remote", "add", name, url], cwd=cwd)
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

    async def _cmd_create_pr(
        self,
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

        remotes_out, remotes_err, remotes_code = await _run_git(["remote"], cwd=cwd)
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

        url_out, url_err, url_code = await _run_git(
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
