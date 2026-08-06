"""Git tool policy: allowlists, write detection, argument validators, schema."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.runtime.safety_breaker import (
    git_forbidden_subcommands,
    git_protected_branches,
)

from .results import _error

if TYPE_CHECKING:
    from agentcore.tools.protocol import ToolResult

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
                "无仓 → success + metadata.code=no_repo；"
                "有 `.git` 但 probe 超时/损坏 → 硬失败（timeout/error，禁止当无仓）。"
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


def _is_ceo_context(context: Any) -> bool:
    """CEO turns carry no worker-only coordination channels."""
    return (
        context.write_coordinator is None
        and context.note_wall is None
        and context.escalation is None
    )
