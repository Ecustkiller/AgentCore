"""Git subprocess spawn, reap, auth hints, repo probe."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

from agentcore.tools.protocol import ToolContext, ToolResult

from . import policy as policy_mod
from .policy import _GIT_TIMEOUT, _PROTECTED_BRANCHES
from .results import _error, _git_failure, _ok


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
        metadata={"code": policy_mod._NO_REPO_CODE},
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
    if code == 0 and stdout.strip() == "true":
        return None
    # Local ``.git`` exists but the probe failed: never soft-succeed as ``no_repo``.
    # Timeout / corrupt / not-a-work-tree are honest errors on both read and write.
    return await _git_failure(stdout, stderr, code or 1, start)


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


