"""Regression tests for GitTool safety guards (``tools/builtin/git_ops``).

Pins the write-path hard rejects that catalog/approval tests do not cover:
forbidden subcommands, protected-branch commits, add-path policy, CEO write ban,
and branch/checkout argument handling. Hermetic: throwaway repos under ``tmp_path``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from typing import Any, Literal

import pytest

from agentcore.tools.builtin.git_ops import (
    _ALLOWED_SUBCOMMANDS,
    _AUTH_FAILURE_HINT,
    _FORBIDDEN_PATTERNS,
    _PROTECTED_BRANCHES,
    GitTool,
    _cloud_network_extra_env,
    _looks_like_auth_failure,
    _validate_add_paths,
    git_write_subcommands,
)
from agentcore.tools.protocol import ToolContext
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.git_credentials import GitAuthMaterial
from agentcore.workspace.server import ServerWorkspace
from agentcore.workspace.write_claims import WriteCoordinator

pytestmark = pytest.mark.skipif(not shutil.which("git"), reason="git not installed")

_GIT_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def test_auth_failure_hint_detects_common_markers():
    assert _looks_like_auth_failure("fatal: Authentication failed for 'https://…'")
    assert _looks_like_auth_failure("remote: HTTP Basic: Access denied")
    assert not _looks_like_auth_failure("fatal: not a git repository")
    assert "设置 → Git 凭据" in _AUTH_FAILURE_HINT


def _run_git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        env=_GIT_ENV,
    )


def _init_repo(path: Path, *, branch: str = "feature/work") -> Path:
    path.mkdir(parents=True, exist_ok=True)
    _run_git(path, "init", "-b", branch)
    _run_git(path, "config", "user.email", "tester@example.com")
    _run_git(path, "config", "user.name", "Tester")
    (path / "README.md").write_text("hello\n", encoding="utf-8")
    _run_git(path, "add", "README.md")
    _run_git(path, "commit", "-m", "init")
    return path


def _attach_bare_origin(repo: Path, bare: Path, *, branch: str) -> None:
    """Init bare remote, push ``branch``, point bare HEAD so clones check out that branch."""
    _run_git(repo.parent, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))
    _run_git(repo, "push", "-u", "origin", branch)
    subprocess.run(
        ["git", "--git-dir", str(bare), "symbolic-ref", "HEAD", f"refs/heads/{branch}"],
        check=True,
        capture_output=True,
        env=_GIT_ENV,
    )


def _clone_from_bare(bare: Path, dest: Path) -> Path:
    _run_git(dest.parent, "clone", str(bare), str(dest))
    _run_git(dest, "config", "user.email", "tester@example.com")
    _run_git(dest, "config", "user.name", "Tester")
    return dest


def _ceo_ctx(workspace: Path) -> ToolContext:
    """CEO path: no worker-only coordination channels."""
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="ceo",
        backend=ServerWorkspace(root=workspace, sandbox=SubprocessSandbox()),
        user_id="u",
    )


def _assert_credential_helper_env(extra: dict[str, str] | None, *, username: str, token: str) -> None:
    assert extra is not None
    assert extra["GIT_CONFIG_COUNT"] == "1"
    assert extra["GIT_CONFIG_KEY_0"] == "credential.helper"
    helper = extra["GIT_CONFIG_VALUE_0"]
    assert f"username={username}" in helper
    assert f"password={token}" in helper


def _worker_ctx(
    workspace: Path,
    *,
    location: Literal["server", "local"] = "server",
    user_id: str = "u",
) -> ToolContext:
    """Worker path: any coordination channel present clears the CEO write ban."""
    return ToolContext(
        execution_id="e",
        run_id="s",
        agent_id="worker",
        backend=ServerWorkspace(
            root=workspace, sandbox=SubprocessSandbox(), location=location
        ),
        user_id=user_id,
        write_coordinator=WriteCoordinator(),
    )


# --- allowlist / forbidden patterns ---


def test_forbidden_patterns_disjoint_from_allowlist():
    # Defense-in-depth: every hard-banned verb must stay outside the allowlist so a
    # future allowlist expansion cannot silently re-enable reset/clean.
    assert _FORBIDDEN_PATTERNS.isdisjoint(_ALLOWED_SUBCOMMANDS)
    assert {"reset", "clean"} <= _FORBIDDEN_PATTERNS
    assert {"rebase", "merge", "stash"} <= _ALLOWED_SUBCOMMANDS
    assert {"cherry-pick", "tag", "remote"} <= _ALLOWED_SUBCOMMANDS
    assert "push" not in _FORBIDDEN_PATTERNS
    assert "push" in _ALLOWED_SUBCOMMANDS
    assert "push" in git_write_subcommands()
    assert "pull" in _ALLOWED_SUBCOMMANDS
    assert "pull" in git_write_subcommands()
    assert "create_pr" in _ALLOWED_SUBCOMMANDS
    assert "create_pr" in git_write_subcommands()
    assert "fetch" in _ALLOWED_SUBCOMMANDS
    assert "fetch" not in git_write_subcommands()
    assert {"show", "blame"} <= _ALLOWED_SUBCOMMANDS
    assert git_write_subcommands().isdisjoint({"fetch", "show", "blame"})
    assert {"merge", "rebase", "cherry-pick"} <= git_write_subcommands()
    assert {"stash", "tag", "remote"} <= git_write_subcommands()


@pytest.mark.parametrize("subcommand", sorted(_FORBIDDEN_PATTERNS))
async def test_forbidden_subcommands_are_rejected(tmp_path: Path, subcommand: str):
    result = await GitTool().execute({"subcommand": subcommand}, _ceo_ctx(tmp_path))
    assert result.success is False
    assert result.error
    # Allowlist rejects first today; forbidden-pattern message is the defense-in-depth
    # wording if a name ever lands in both sets. Either path must refuse.
    assert (
        "不在允许列表中" in result.error
        or "被安全策略拒绝" in result.error
    )


async def test_unknown_subcommand_rejected(tmp_path: Path):
    result = await GitTool().execute({"subcommand": "reflog"}, _ceo_ctx(tmp_path))
    assert result.success is False
    assert "不在允许列表中" in (result.error or "")


# --- CEO write ban ---


@pytest.mark.parametrize(
    "subcommand",
    sorted(s for s in git_write_subcommands() if s != "init_baseline"),
)
async def test_ceo_context_rejects_all_write_subcommands(tmp_path: Path, subcommand: str):
    _init_repo(tmp_path / "repo")
    args: dict[str, Any] = {"subcommand": subcommand}
    if subcommand == "add":
        args["paths"] = ["README.md"]
    elif subcommand == "commit":
        args["message"] = "x"
    elif subcommand in ("branch", "checkout"):
        args["branch"] = "other"
    elif subcommand in ("merge", "rebase", "cherry-pick"):
        args["ref"] = "other"
    elif subcommand == "stash":
        args["action"] = "push"
    elif subcommand == "tag":
        args["action"] = "create"
        args["name"] = "v0"
    elif subcommand == "remote":
        args["action"] = "add"
        args["name"] = "upstream"
        args["url"] = "https://example.com/repo.git"
    elif subcommand == "create_pr":
        args["title"] = "PR"
    result = await GitTool().execute(args, _ceo_ctx(tmp_path / "repo"))
    assert result.success is False
    assert "delegate" in (result.error or "").lower() or "Worker" in (result.error or "")


async def test_ceo_context_allows_read_status(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(repo))
    assert result.success is True
    assert "当前分支" in result.output


async def test_status_refuses_parent_repo_when_workspace_has_no_git(tmp_path: Path):
    """Workspace nested under a parent git tree must not operate the parent repo.

    Reproduces host-path leak class: data_dir / scratch lives under the monorepo
    (e.g. ``C:/Project/...``); without a ceiling, ``git status`` would climb out.
    Read-only returns structured ``no_repo`` (success) — never a fake clean tree.
    """
    parent = _init_repo(tmp_path / "parent", branch="feature/parent")
    nested = parent / "nested_workspace"
    nested.mkdir()
    (nested / "notes.txt").write_text("scratch only\n", encoding="utf-8")
    assert not (nested / ".git").exists()

    # Sanity: plain git *would* see the parent work tree from nested cwd.
    climbed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=nested,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert Path(climbed.stdout.strip()).resolve() == parent.resolve()

    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(nested))
    assert result.success is True
    assert result.metadata.get("code") == "no_repo"
    assert "没有 Git 仓库" in result.output
    # Must not echo parent branch / status as if nested were the repo.
    assert "feature/parent" not in (result.output or "")
    assert "当前分支" not in (result.output or "")
    assert "工作区干净" not in (result.output or "")


async def test_status_uses_workspace_repo_not_parent(tmp_path: Path):
    """When the workspace has its own ``.git``, operate that repo — not a parent."""
    parent = _init_repo(tmp_path / "parent", branch="feature/parent")
    nested = _init_repo(parent / "nested_repo", branch="feature/nested")
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(nested))
    assert result.success is True
    assert "feature/nested" in result.output
    assert "feature/parent" not in result.output


async def test_no_git_anywhere_reports_structured_no_repo(tmp_path: Path):
    bare = tmp_path / "not_a_repo"
    bare.mkdir()
    for sub in ("status", "diff", "log", "fetch", "show", "blame"):
        result = await GitTool().execute({"subcommand": sub}, _ceo_ctx(bare))
        assert result.success is True
        assert result.metadata.get("code") == "no_repo"
        assert "没有 Git 仓库" in result.output
        assert "工作区干净" not in result.output
        assert "无差异" not in result.output
        assert "无提交" not in result.output


async def test_status_ensure_timeout_is_hard_error_not_no_repo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """``.git`` present + rev-parse hang → error/timeout, never soft ``no_repo``."""
    import agentcore.tools.builtin.git_ops as git_mod

    repo = _init_repo(tmp_path / "repo")

    async def _fake_run(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ) -> tuple[str, str, int]:
        if args[:2] == ["rev-parse", "--is-inside-work-tree"]:
            return "", "git 操作超时（rev-parse --is-inside-work-tree）", 1
        raise AssertionError(f"unexpected git args: {args}")

    monkeypatch.setattr(git_mod.spawn, "_run_git", _fake_run)
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(repo))
    assert result.success is False
    assert result.metadata.get("code") == "timeout"
    assert result.metadata.get("timeout_layer") == "inner"
    assert "超时" in (result.error or "")
    assert "勿原样重试" in (result.error or "")


async def test_status_ensure_probe_failure_not_soft_no_repo(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """``.git`` present but not a work tree → hard fail, not soft ``no_repo``."""
    import agentcore.tools.builtin.git_ops as git_mod

    repo = _init_repo(tmp_path / "repo")

    async def _fake_run(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ) -> tuple[str, str, int]:
        if args[:2] == ["rev-parse", "--is-inside-work-tree"]:
            return (
                "",
                "fatal: not a git repository (or any of the parent directories): .git",
                128,
            )
        raise AssertionError(f"unexpected git args: {args}")

    monkeypatch.setattr(git_mod.spawn, "_run_git", _fake_run)
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(repo))
    assert result.success is False
    assert result.metadata.get("code") != "no_repo"
    assert "not a git repository" in (result.error or "").lower()


async def test_write_without_repo_still_hard_fails(tmp_path: Path):
    bare = tmp_path / "not_a_repo"
    bare.mkdir()
    (bare / "README.md").write_text("x\n", encoding="utf-8")
    result = await GitTool().execute(
        {"subcommand": "add", "paths": ["README.md"]},
        _worker_ctx(bare),
    )
    assert result.success is False
    assert "没有 Git 仓库" in (result.error or "")


# --- add path policy ---


@pytest.mark.parametrize(
    "paths,needle",
    [
        ([], "显式 paths"),
        (["."], "禁止 add 路径"),
        (["-A"], "禁止 add 路径"),
        (["--all"], "禁止 add 路径"),
        (["src/*.py"], "通配符"),
        (["foo?.txt"], "通配符"),
        ([""], "空路径"),
    ],
)
def test_validate_add_paths_rejects_dangerous_inputs(paths: list[str], needle: str):
    err = _validate_add_paths(paths, start=0.0)
    assert err is not None
    assert err.success is False
    assert needle in (err.error or "")


def test_validate_add_paths_accepts_explicit_files():
    assert _validate_add_paths(["src/a.py", "docs/readme.md"], start=0.0) is None


async def test_add_rejects_dot_via_execute(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute(
        {"subcommand": "add", "paths": ["."]},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "禁止 add" in (result.error or "")


# --- protected branches ---


@pytest.mark.parametrize("branch", sorted(_PROTECTED_BRANCHES))
async def test_commit_on_protected_branch_rejected(tmp_path: Path, branch: str):
    repo = _init_repo(tmp_path / "repo", branch=branch)
    (repo / "extra.txt").write_text("x\n", encoding="utf-8")
    _run_git(repo, "add", "extra.txt")
    result = await GitTool().execute(
        {"subcommand": "commit", "message": "should not land"},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "main/master" in (result.error or "")
    # Working tree still has the staged file — commit did not happen.
    status = subprocess.run(
        ["git", "status", "--short"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert "extra.txt" in status.stdout


async def test_commit_on_feature_branch_allowed(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/ok")
    (repo / "extra.txt").write_text("x\n", encoding="utf-8")
    result = await GitTool().execute(
        {"subcommand": "add", "paths": ["extra.txt"]},
        _worker_ctx(repo),
    )
    assert result.success is True
    result = await GitTool().execute(
        {"subcommand": "commit", "message": "add extra"},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "已提交" in result.output


# --- branch / checkout args ---


async def test_branch_requires_branch_name(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "branch"}, _worker_ctx(repo))
    assert result.success is False
    assert "branch 需要 branch 参数" in (result.error or "")


async def test_checkout_requires_branch_name(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "checkout"}, _worker_ctx(repo))
    assert result.success is False
    assert "checkout 需要 branch 参数" in (result.error or "")


@pytest.mark.parametrize("branch", ["-f", "--force", "-D"])
async def test_branch_rejects_option_like_names(tmp_path: Path, branch: str):
    # audit 05 P3-1: a ``-``-prefixed branch would be parsed by git as an option
    # (e.g. ``branch -f``); reject before it ever reaches argv.
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute(
        {"subcommand": "branch", "branch": branch},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "'-' 开头" in (result.error or "")


@pytest.mark.parametrize("branch", ["-f", "--force", "-D"])
async def test_checkout_rejects_option_like_names(tmp_path: Path, branch: str):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute(
        {"subcommand": "checkout", "branch": branch},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "'-' 开头" in (result.error or "")


async def test_branch_creates_named_branch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute(
        {"subcommand": "branch", "branch": "feature/new"},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "已创建分支 feature/new" in result.output
    branches = subprocess.run(
        ["git", "branch", "--list", "feature/new"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert "feature/new" in branches.stdout


async def test_checkout_create_switches_to_new_branch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/base")
    result = await GitTool().execute(
        {"subcommand": "checkout", "branch": "feature/created", "create": True},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "已创建并切换到分支 feature/created" in result.output
    current = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert current.stdout.strip() == "feature/created"


async def test_checkout_switches_existing_branch(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/a")
    _run_git(repo, "branch", "feature/b")
    result = await GitTool().execute(
        {"subcommand": "checkout", "branch": "feature/b"},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "已切换到分支 feature/b" in result.output
    current = subprocess.run(
        ["git", "branch", "--show-current"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert current.stdout.strip() == "feature/b"


async def test_commit_requires_message(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "commit"}, _worker_ctx(repo))
    assert result.success is False
    assert "message" in (result.error or "")


# --- push ---


async def test_push_ceo_rejected_like_other_writes(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "push"}, _ceo_ctx(repo))
    assert result.success is False
    assert "delegate" in (result.error or "").lower() or "Worker" in (result.error or "")


@pytest.mark.parametrize("branch", sorted(_PROTECTED_BRANCHES))
async def test_push_on_protected_branch_rejected(tmp_path: Path, branch: str):
    repo = _init_repo(tmp_path / "repo", branch=branch)
    result = await GitTool().execute({"subcommand": "push"}, _worker_ctx(repo))
    assert result.success is False
    assert "main/master" in (result.error or "")


async def test_push_without_remote_clear_error(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "push"}, _worker_ctx(repo))
    assert result.success is False
    err = result.error or ""
    assert "remote" in err.lower()
    assert "配置" in err or "凭据" in err


async def test_push_rejects_force_and_refspec_args(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    for args in (
        {"subcommand": "push", "force": True},
        {"subcommand": "push", "force_with_lease": True},
        {"subcommand": "push", "refspec": "feature:main"},
        {"subcommand": "push", "branch": "main"},
        {"subcommand": "push", "remote": "--force"},
        {"subcommand": "push", "remote": "origin feature:main"},
    ):
        result = await GitTool().execute(args, _worker_ctx(repo))
        assert result.success is False
        assert result.error


async def test_push_to_local_bare_remote(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/ship")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))
    result = await GitTool().execute(
        {"subcommand": "push", "set_upstream": True},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert "已推送 feature/ship → origin" in result.output
    # Remote received the branch.
    listed = subprocess.run(
        ["git", "--git-dir", str(bare), "branch", "--list", "feature/ship"],
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert "feature/ship" in listed.stdout


# --- fetch / pull / show / blame (G1) ---


def test_pull_requires_approval_fetch_does_not():
    from agentcore.core.types import ToolApproval
    from agentcore.runtime.approvals import tool_call_requires_approval

    schema_approval = ToolApproval.NEVER
    assert (
        tool_call_requires_approval(
            "git", schema_approval, {"subcommand": "pull", "remote": "origin"}
        )
        is True
    )
    assert (
        tool_call_requires_approval(
            "git", schema_approval, {"subcommand": "fetch", "remote": "origin"}
        )
        is False
    )
    assert (
        tool_call_requires_approval(
            "git", schema_approval, {"subcommand": "show"}
        )
        is False
    )
    assert (
        tool_call_requires_approval(
            "git", schema_approval, {"subcommand": "blame", "paths": ["README.md"]}
        )
        is False
    )


async def test_ceo_allows_fetch_show_blame(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    for sub, args in (
        ("show", {"subcommand": "show"}),
        ("blame", {"subcommand": "blame", "paths": ["README.md"]}),
    ):
        result = await GitTool().execute(args, _ceo_ctx(repo))
        assert result.success is True, f"{sub}: {result.error}"


async def test_fetch_from_local_bare_remote(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/ship")
    bare = tmp_path / "remote.git"
    _attach_bare_origin(repo, bare, branch="feature/ship")

    # Advance remote with a second clone so fetch has something new.
    other = _clone_from_bare(bare, tmp_path / "other")
    (other / "extra.txt").write_text("from remote\n", encoding="utf-8")
    _run_git(other, "add", "extra.txt")
    _run_git(other, "commit", "-m", "remote advance")
    _run_git(other, "push", "origin", "HEAD")

    result = await GitTool().execute(
        {"subcommand": "fetch", "remote": "origin"},
        _ceo_ctx(repo),
    )
    assert result.success is True
    assert "fetch" in result.output.lower() or "已从 origin" in result.output
    # Tracking ref updated; working tree not merged (fetch ≠ pull).
    assert not (repo / "extra.txt").exists()


async def test_pull_ff_only_succeeds(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/ship")
    bare = tmp_path / "remote.git"
    _attach_bare_origin(repo, bare, branch="feature/ship")

    other = _clone_from_bare(bare, tmp_path / "other")
    (other / "extra.txt").write_text("ff me\n", encoding="utf-8")
    _run_git(other, "add", "extra.txt")
    _run_git(other, "commit", "-m", "remote ff")
    _run_git(other, "push", "origin", "HEAD")

    result = await GitTool().execute(
        {"subcommand": "pull", "remote": "origin"},
        _worker_ctx(repo),
    )
    assert result.success is True
    assert result.metadata.get("ff_only") is True
    assert (repo / "extra.txt").read_text(encoding="utf-8") == "ff me\n"


async def test_pull_non_ff_fails_honestly(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/ship")
    bare = tmp_path / "remote.git"
    _attach_bare_origin(repo, bare, branch="feature/ship")

    # Divergent histories: local and remote each add a distinct commit.
    (repo / "local.txt").write_text("local\n", encoding="utf-8")
    _run_git(repo, "add", "local.txt")
    _run_git(repo, "commit", "-m", "local only")

    other = _clone_from_bare(bare, tmp_path / "other")
    (other / "remote.txt").write_text("remote\n", encoding="utf-8")
    _run_git(other, "add", "remote.txt")
    _run_git(other, "commit", "-m", "remote only")
    _run_git(other, "push", "origin", "HEAD")

    result = await GitTool().execute(
        {"subcommand": "pull", "remote": "origin"},
        _worker_ctx(repo),
    )
    assert result.success is False
    err = (result.error or "").lower()
    assert (
        "fast-forward" in err
        or "not possible" in err
        or "diverg" in err
        or "拒绝" in (result.error or "")
        or "冲突" in (result.error or "")
        or "无法" in (result.error or "")
        or "ff" in err
    )
    # Local-only commit must remain; no silent merge.
    assert (repo / "local.txt").exists()
    assert not (repo / "remote.txt").exists()


async def test_pull_rejects_strategy_knobs(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    for args in (
        {"subcommand": "pull", "rebase": True},
        {"subcommand": "pull", "no_ff": True},
        {"subcommand": "pull", "strategy": "recursive"},
    ):
        result = await GitTool().execute(args, _worker_ctx(repo))
        assert result.success is False
        assert "ff-only" in (result.error or "").lower() or "快进" in (result.error or "")


async def test_pull_without_repo_hard_fails(tmp_path: Path):
    bare = tmp_path / "not_a_repo"
    bare.mkdir()
    result = await GitTool().execute(
        {"subcommand": "pull"},
        _worker_ctx(bare),
    )
    assert result.success is False
    assert "没有 Git 仓库" in (result.error or "")


async def test_pull_passes_ff_only_flag(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agentcore.tools.builtin import git_ops as git_mod

    repo = _init_repo(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))

    seen: list[list[str]] = []
    real_run = git_mod.spawn._run_git

    async def _spy(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ):
        seen.append(list(args))
        return await real_run(args, cwd=cwd, timeout=timeout, extra_env=extra_env)

    monkeypatch.setattr(git_mod.spawn, "_run_git", _spy)
    await GitTool().execute(
        {"subcommand": "pull", "remote": "origin"},
        _worker_ctx(repo),
    )
    pull_calls = [a for a in seen if a and a[0] == "pull"]
    assert pull_calls
    assert pull_calls[0][:2] == ["pull", "--ff-only"]
    assert "origin" in pull_calls[0]


# --- cloud PAT → credential.helper injection (UNSURE audit) ---


async def test_cloud_network_extra_env_with_pat(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    auth = GitAuthMaterial(username="x-access-token", token="pat-secret")

    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return auth

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    ctx = _worker_ctx(tmp_path, location="server", user_id="u1")
    extra = await _cloud_network_extra_env(ctx)
    _assert_credential_helper_env(extra, username="x-access-token", token="pat-secret")


async def test_cloud_network_extra_env_no_pat(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    ctx = _worker_ctx(tmp_path, location="server", user_id="u1")
    assert await _cloud_network_extra_env(ctx) is None


async def test_cloud_network_extra_env_local_skips_even_with_pat(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return GitAuthMaterial(username="x-access-token", token="pat-secret")

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )
    ctx = _worker_ctx(tmp_path, location="local", user_id="u1")
    assert await _cloud_network_extra_env(ctx) is None


@pytest.mark.parametrize("subcommand", ["push", "fetch", "pull"])
async def test_network_cmds_inject_extra_env_when_cloud_pat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, subcommand: str
):
    """Prove push/fetch/pull pass GIT_CONFIG_* credential.helper into ``_run_git``."""
    from agentcore.tools.builtin import git_ops as git_mod

    auth = GitAuthMaterial(username="gh-user", token="gh-pat")

    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return auth

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )

    repo = _init_repo(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))

    seen_extra: list[dict[str, str] | None] = []
    real_run = git_mod.spawn._run_git

    async def _spy(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ):
        if args and args[0] == subcommand:
            seen_extra.append(extra_env)
        return await real_run(args, cwd=cwd, timeout=timeout, extra_env=extra_env)

    monkeypatch.setattr(git_mod.spawn, "_run_git", _spy)
    await GitTool().execute(
        {"subcommand": subcommand, "remote": "origin"},
        _worker_ctx(repo, location="server"),
    )
    assert seen_extra, f"expected a {subcommand} _run_git call"
    _assert_credential_helper_env(seen_extra[0], username="gh-user", token="gh-pat")


@pytest.mark.parametrize("subcommand", ["push", "fetch", "pull"])
async def test_network_cmds_no_extra_env_without_pat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, subcommand: str
):
    from agentcore.tools.builtin import git_ops as git_mod

    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return None

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )

    repo = _init_repo(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))

    seen_extra: list[dict[str, str] | None] = []
    real_run = git_mod.spawn._run_git

    async def _spy(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ):
        if args and args[0] == subcommand:
            seen_extra.append(extra_env)
        return await real_run(args, cwd=cwd, timeout=timeout, extra_env=extra_env)

    monkeypatch.setattr(git_mod.spawn, "_run_git", _spy)
    await GitTool().execute(
        {"subcommand": subcommand, "remote": "origin"},
        _worker_ctx(repo, location="server"),
    )
    assert seen_extra, f"expected a {subcommand} _run_git call"
    assert seen_extra[0] is None


@pytest.mark.parametrize("subcommand", ["push", "fetch", "pull"])
async def test_network_cmds_local_no_extra_env_even_with_pat(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, subcommand: str
):
    from agentcore.tools.builtin import git_ops as git_mod

    async def _load(_user_id: str) -> GitAuthMaterial | None:
        return GitAuthMaterial(username="gh-user", token="gh-pat")

    monkeypatch.setattr(
        "agentcore.workspace.git_credentials.load_git_auth_for_user",
        _load,
    )

    repo = _init_repo(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    _run_git(repo, "remote", "add", "origin", str(bare))

    seen_extra: list[dict[str, str] | None] = []
    real_run = git_mod.spawn._run_git

    async def _spy(
        args: list[str],
        *,
        cwd: str,
        timeout: float = 20.0,
        extra_env: dict[str, str] | None = None,
    ):
        if args and args[0] == subcommand:
            seen_extra.append(extra_env)
        return await real_run(args, cwd=cwd, timeout=timeout, extra_env=extra_env)

    monkeypatch.setattr(git_mod.spawn, "_run_git", _spy)
    await GitTool().execute(
        {"subcommand": subcommand, "remote": "origin"},
        _worker_ctx(repo, location="local"),
    )
    assert seen_extra, f"expected a {subcommand} _run_git call"
    assert seen_extra[0] is None


async def test_show_and_blame_basic(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    shown = await GitTool().execute({"subcommand": "show"}, _ceo_ctx(repo))
    assert shown.success is True
    assert "hello" in shown.output or "init" in shown.output

    blamed = await GitTool().execute(
        {"subcommand": "blame", "paths": ["README.md"]},
        _ceo_ctx(repo),
    )
    assert blamed.success is True
    assert "hello" in blamed.output
    assert blamed.metadata.get("path") == "README.md"


async def test_blame_requires_single_path(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    empty = await GitTool().execute({"subcommand": "blame"}, _ceo_ctx(repo))
    assert empty.success is False
    assert "paths" in (empty.error or "")

    multi = await GitTool().execute(
        {"subcommand": "blame", "paths": ["README.md", "other.txt"]},
        _ceo_ctx(repo),
    )
    assert multi.success is False
    assert "一个文件" in (multi.error or "")


async def test_show_truncates_long_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from agentcore.tools.builtin import git_ops as git_mod

    monkeypatch.setattr(git_mod.policy, "_DIFF_OUTPUT_LIMIT", 80)
    repo = _init_repo(tmp_path / "repo")
    (repo / "big.txt").write_text("x" * 400 + "\n", encoding="utf-8")
    _run_git(repo, "add", "big.txt")
    _run_git(repo, "commit", "-m", "big")
    result = await GitTool().execute(
        {"subcommand": "show", "object": "HEAD"},
        _ceo_ctx(repo),
    )
    assert result.success is True
    assert len(result.output) <= 80 + 50  # truncate_head_tail may use marker
    assert "系统视图截断" in result.output or "……" in result.output


async def test_blame_truncates_long_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    from agentcore.tools.builtin import git_ops as git_mod

    monkeypatch.setattr(git_mod.policy, "_BLAME_LINE_LIMIT", 3)
    repo = _init_repo(tmp_path / "repo")
    (repo / "lines.txt").write_text(
        "\n".join(f"line-{i}" for i in range(8)) + "\n", encoding="utf-8"
    )
    _run_git(repo, "add", "lines.txt")
    _run_git(repo, "commit", "-m", "lines")
    result = await GitTool().execute(
        {"subcommand": "blame", "paths": ["lines.txt"]},
        _ceo_ctx(repo),
    )
    assert result.success is True
    assert "已截断" in result.output
    assert result.metadata.get("truncated") is True
    assert (result.metadata.get("blame_lines") or 0) >= 4


# --- timeout contract / status narrowing ---


def test_git_tool_timeout_outlives_inner_ops():
    from agentcore.runtime.engine import resolve_tool_timeout
    from agentcore.tools.builtin.git_ops import (
        _GIT_KILL_SLACK,
        _GIT_TIMEOUT,
        git_tool_timeout_seconds,
    )

    schema = GitTool().schema
    assert schema.timeout_seconds is None
    status_ceiling = git_tool_timeout_seconds({"subcommand": "status"})
    commit_ceiling = git_tool_timeout_seconds({"subcommand": "commit"})
    pull_ceiling = git_tool_timeout_seconds({"subcommand": "pull"})
    fetch_ceiling = git_tool_timeout_seconds({"subcommand": "fetch"})
    assert status_ceiling == 2 * _GIT_TIMEOUT + _GIT_KILL_SLACK
    assert commit_ceiling == 4 * _GIT_TIMEOUT + _GIT_KILL_SLACK
    assert commit_ceiling > status_ceiling
    assert pull_ceiling == fetch_ceiling == (
        2 * _GIT_TIMEOUT + _GIT_TIMEOUT + 60.0 + _GIT_KILL_SLACK
    )
    assert resolve_tool_timeout(schema, {"subcommand": "status"}) == status_ceiling
    assert resolve_tool_timeout(schema, {"subcommand": "commit"}) == commit_ceiling
    assert resolve_tool_timeout(schema, {"subcommand": "pull"}) == pull_ceiling


async def test_status_hides_untracked_by_default(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    (repo / "ghost.txt").write_text("untracked\n", encoding="utf-8")
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(repo))
    assert result.success is True
    assert "ghost.txt" not in result.output
    assert result.metadata.get("include_untracked") is False

    shown = await GitTool().execute(
        {"subcommand": "status", "include_untracked": True},
        _ceo_ctx(repo),
    )
    assert shown.success is True
    assert "ghost.txt" in shown.output
    assert shown.metadata.get("include_untracked") is True


async def test_status_truncates_long_porcelain(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from agentcore.tools.builtin import git_ops as git_mod

    monkeypatch.setattr(git_mod.policy, "_STATUS_LINE_LIMIT", 3)
    repo = _init_repo(tmp_path / "repo")
    for i in range(6):
        (repo / f"f{i}.txt").write_text(f"{i}\n", encoding="utf-8")
        _run_git(repo, "add", f"f{i}.txt")
    result = await GitTool().execute({"subcommand": "status"}, _ceo_ctx(repo))
    assert result.success is True
    assert "已截断" in result.output
    assert result.metadata.get("truncated") is True
    assert (result.metadata.get("status_lines") or 0) >= 4


def test_parse_status_sb_extracts_branch():
    from agentcore.tools.builtin.git_ops import _parse_status_sb

    branch, body = _parse_status_sb("## feature/work...origin/feature/work\n M a.py\n")
    assert branch == "feature/work"
    assert "M a.py" in body
    branch2, body2 = _parse_status_sb("## main\n")
    assert branch2 == "main"
    assert body2 == ""


# --- init_baseline (P3 soft git baseline) ---


async def test_init_baseline_creates_repo_and_first_commit(tmp_path: Path):
    bare = tmp_path / "project"
    bare.mkdir()
    (bare / "app.py").write_text("print('hi')\n", encoding="utf-8")
    assert not (bare / ".git").exists()

    result = await GitTool().execute({"subcommand": "init_baseline"}, _ceo_ctx(bare))
    assert result.success is True
    assert (bare / ".git").exists()
    assert "首提交" in result.output or "baseline" in result.output.lower()
    assert result.metadata.get("sha")
    # Tree is tracked after first commit.
    status = await GitTool().execute(
        {"subcommand": "status", "include_untracked": True}, _ceo_ctx(bare)
    )
    assert status.success is True
    assert "app.py" not in (status.output or "") or "工作区干净" in (status.output or "")


async def test_init_baseline_dirty_existing_repo_skips_commit(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    (repo / "README.md").write_text("dirty\n", encoding="utf-8")
    result = await GitTool().execute({"subcommand": "init_baseline"}, _ceo_ctx(repo))
    assert result.success is True
    assert result.metadata.get("code") == "dirty_skip"
    assert "不代为 commit" in result.output
    # Dirty content must remain uncommitted.
    porcelain = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert porcelain.stdout.strip()


async def test_init_baseline_clean_existing_repo_reports_already(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute({"subcommand": "init_baseline"}, _ceo_ctx(repo))
    assert result.success is True
    assert result.metadata.get("code") == "already_repo"
    assert "无需 init_baseline" in result.output


def test_init_baseline_in_write_allowlist():
    assert "init_baseline" in _ALLOWED_SUBCOMMANDS
    assert "init_baseline" in git_write_subcommands()


# --- G2 collaboration: stash / merge / rebase / cherry-pick / tag / remote ---


def test_g2_list_actions_skip_approval_writes_require():
    from agentcore.core.types import ToolApproval
    from agentcore.runtime.approvals import tool_call_requires_approval
    from agentcore.tools.builtin.git_ops import git_call_is_write

    schema = ToolApproval.NEVER
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "stash", "action": "list"}
    ) is False
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "stash", "action": "push"}
    ) is True
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "tag", "action": "list"}
    ) is False
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "tag", "action": "create", "name": "v1"}
    ) is True
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "remote", "action": "list"}
    ) is False
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "remote", "action": "add", "name": "u", "url": "https://x"}
    ) is True
    assert tool_call_requires_approval(
        "git", schema, {"subcommand": "merge", "ref": "other"}
    ) is True
    assert git_call_is_write({"subcommand": "stash"}) is False  # default list
    assert git_call_is_write({"subcommand": "stash", "action": "pop"}) is True


async def test_stash_list_push_pop_roundtrip(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    (repo / "README.md").write_text("stashed\n", encoding="utf-8")
    push = await GitTool().execute(
        {"subcommand": "stash", "action": "push", "message": "wip"},
        _worker_ctx(repo),
    )
    assert push.success is True, push.error
    porcelain = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    )
    assert not porcelain.stdout.strip()

    listed = await GitTool().execute(
        {"subcommand": "stash", "action": "list"}, _ceo_ctx(repo)
    )
    assert listed.success is True
    assert "wip" in listed.output or "stash@{" in listed.output

    pop = await GitTool().execute(
        {"subcommand": "stash", "action": "pop"}, _worker_ctx(repo)
    )
    assert pop.success is True, pop.error
    assert (repo / "README.md").read_text(encoding="utf-8") == "stashed\n"


async def test_stash_drop_clear_rejected(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    for action in ("drop", "clear"):
        result = await GitTool().execute(
            {"subcommand": "stash", "action": action}, _worker_ctx(repo)
        )
        assert result.success is False
        assert "禁止" in (result.error or "")


async def test_merge_succeeds_and_conflict_stops_honestly(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/base")
    _run_git(repo, "checkout", "-b", "feature/a")
    (repo / "README.md").write_text("A\n", encoding="utf-8")
    _run_git(repo, "add", "README.md")
    _run_git(repo, "commit", "-m", "a")
    _run_git(repo, "checkout", "feature/base")
    _run_git(repo, "checkout", "-b", "feature/b")
    (repo / "README.md").write_text("B\n", encoding="utf-8")
    _run_git(repo, "add", "README.md")
    _run_git(repo, "commit", "-m", "b")

    # Clean merge from a common ancestor with a non-conflicting side branch.
    _run_git(repo, "checkout", "feature/base")
    (repo / "other.txt").write_text("ok\n", encoding="utf-8")
    _run_git(repo, "add", "other.txt")
    _run_git(repo, "commit", "-m", "base advance")
    ok = await GitTool().execute(
        {"subcommand": "merge", "ref": "feature/a"}, _worker_ctx(repo)
    )
    assert ok.success is True, ok.error
    assert "已合并" in ok.output

    # Conflict: merge feature/b into feature/a lineage.
    _run_git(repo, "checkout", "feature/a")
    conflict = await GitTool().execute(
        {"subcommand": "merge", "ref": "feature/b"}, _worker_ctx(repo)
    )
    assert conflict.success is False
    assert conflict.metadata.get("conflict") is True or "冲突" in (conflict.error or "")
    assert "自动 resolve" in (conflict.error or "") or "诚实" in (conflict.error or "")


async def test_merge_rejects_force_knobs(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    result = await GitTool().execute(
        {"subcommand": "merge", "ref": "other", "force": True},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "禁止" in (result.error or "") or "旋钮" in (result.error or "")


async def test_rebase_onto_upstream(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/mainline")
    (repo / "base.txt").write_text("base\n", encoding="utf-8")
    _run_git(repo, "add", "base.txt")
    _run_git(repo, "commit", "-m", "basefile")
    _run_git(repo, "checkout", "-b", "feature/topic")
    (repo / "topic.txt").write_text("topic\n", encoding="utf-8")
    _run_git(repo, "add", "topic.txt")
    _run_git(repo, "commit", "-m", "topic")
    _run_git(repo, "checkout", "feature/mainline")
    (repo / "base.txt").write_text("base2\n", encoding="utf-8")
    _run_git(repo, "add", "base.txt")
    _run_git(repo, "commit", "-m", "mainline advance")
    _run_git(repo, "checkout", "feature/topic")
    result = await GitTool().execute(
        {"subcommand": "rebase", "ref": "feature/mainline"},
        _worker_ctx(repo),
    )
    assert result.success is True, result.error
    assert "rebase" in result.output.lower() or "已 rebase" in result.output


async def test_rebase_conflict_stops(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/mainline")
    (repo / "README.md").write_text("main\n", encoding="utf-8")
    _run_git(repo, "add", "README.md")
    _run_git(repo, "commit", "-m", "main edit")
    _run_git(repo, "checkout", "-b", "feature/topic")
    # Reset topic to before main edit, then diverge.
    _run_git(repo, "reset", "--hard", "HEAD~1")
    (repo / "README.md").write_text("topic\n", encoding="utf-8")
    _run_git(repo, "add", "README.md")
    _run_git(repo, "commit", "-m", "topic edit")
    result = await GitTool().execute(
        {"subcommand": "rebase", "ref": "feature/mainline"},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert result.metadata.get("conflict") is True or "冲突" in (result.error or "")


async def test_cherry_pick_applies_commit(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="feature/a")
    (repo / "pick.txt").write_text("picked\n", encoding="utf-8")
    _run_git(repo, "add", "pick.txt")
    _run_git(repo, "commit", "-m", "to pick")
    sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=_GIT_ENV,
    ).stdout.strip()
    _run_git(repo, "checkout", "-b", "feature/b")
    _run_git(repo, "reset", "--hard", "HEAD~1")
    result = await GitTool().execute(
        {"subcommand": "cherry-pick", "ref": sha},
        _worker_ctx(repo),
    )
    assert result.success is True, result.error
    assert (repo / "pick.txt").read_text(encoding="utf-8") == "picked\n"


async def test_tag_list_and_create_rejects_delete(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    created = await GitTool().execute(
        {"subcommand": "tag", "action": "create", "name": "v1.0"},
        _worker_ctx(repo),
    )
    assert created.success is True, created.error
    listed = await GitTool().execute(
        {"subcommand": "tag", "action": "list"}, _ceo_ctx(repo)
    )
    assert listed.success is True
    assert "v1.0" in listed.output
    deleted = await GitTool().execute(
        {"subcommand": "tag", "action": "delete", "name": "v1.0"},
        _worker_ctx(repo),
    )
    assert deleted.success is False
    assert "禁止" in (deleted.error or "")


async def test_remote_list_and_add_rejects_remove(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    bare = tmp_path / "remote.git"
    _run_git(tmp_path, "init", "--bare", str(bare))
    added = await GitTool().execute(
        {
            "subcommand": "remote",
            "action": "add",
            "name": "origin",
            "url": str(bare),
        },
        _worker_ctx(repo),
    )
    assert added.success is True, added.error
    listed = await GitTool().execute(
        {"subcommand": "remote", "action": "list"}, _ceo_ctx(repo)
    )
    assert listed.success is True
    assert "origin" in listed.output
    removed = await GitTool().execute(
        {"subcommand": "remote", "action": "remove", "name": "origin"},
        _worker_ctx(repo),
    )
    assert removed.success is False
    assert "禁止" in (removed.error or "")


async def test_reset_and_clean_still_rejected(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo")
    for sub in ("reset", "clean"):
        result = await GitTool().execute({"subcommand": sub}, _worker_ctx(repo))
        assert result.success is False
        assert (
            "不在允许列表中" in (result.error or "")
            or "被安全策略拒绝" in (result.error or "")
        )


async def test_merge_on_protected_branch_rejected(tmp_path: Path):
    repo = _init_repo(tmp_path / "repo", branch="main")
    _run_git(repo, "checkout", "-b", "feature/side")
    (repo / "side.txt").write_text("s\n", encoding="utf-8")
    _run_git(repo, "add", "side.txt")
    _run_git(repo, "commit", "-m", "side")
    _run_git(repo, "checkout", "main")
    result = await GitTool().execute(
        {"subcommand": "merge", "ref": "feature/side"},
        _worker_ctx(repo),
    )
    assert result.success is False
    assert "main/master" in (result.error or "")
