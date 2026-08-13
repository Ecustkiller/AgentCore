"""ToolResult helpers + output truncation for git_ops."""

from __future__ import annotations

import time
from typing import Any

from agentcore.tools.protocol import ToolResult

from . import policy as policy_mod


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


async def _git_failure(
    stdout: str, stderr: str, exit_code: int, start: float, **kwargs: Any
) -> ToolResult:
    from .spawn import (
        _AUTH_FAILURE_HINT,
        _UNUSABLE_REPO_HINT,
        _looks_like_auth_failure,
        _looks_like_unusable_repo,
    )

    detail = (stderr or stdout or f"git 退出码 {exit_code}").strip()
    meta = dict(kwargs.pop("metadata", {}) or {})
    if "超时" in detail:
        meta.setdefault("timeout_layer", "inner")
        meta.setdefault("code", "timeout")
        if "勿原样重试" not in detail:
            detail = (
                f"{detail}\n"
                "（活性超时：勿原样重试同一命令；若持续失败可检查 .git/index.lock 或其它 git 占用。）"
            )
    elif _looks_like_unusable_repo(stderr or stdout):
        # Reached only with a root ``.git`` present (no-repo forks off earlier), so
        # this stays a hard error — a broken repo is never soft ``no_repo``.
        meta.setdefault("code", policy_mod._REPO_UNUSABLE_CODE)
        if _UNUSABLE_REPO_HINT not in detail:
            detail = f"{detail}\n{_UNUSABLE_REPO_HINT}"
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
        body, limit=policy_mod._STATUS_LINE_LIMIT, hint="请用 paths 收窄范围"
    )

