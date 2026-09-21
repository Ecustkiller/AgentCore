"""Product-landing path gate for pinned ``artifacts`` / ``artifact_dir``.

Any successful workspace write counts as product landing. Declared
``deliverable.artifacts`` no longer gate whether a path counts.
"""

from __future__ import annotations

from collections.abc import Sequence

from agentcore.tools.file_products import LANDING_TOOLS
from agentcore.workspace._paths import sanitize_write_relpath

__all__ = [
    "is_product_landing_path",
    "filter_product_landing_paths",
    "landing_tool_path_from_args",
]


def is_product_landing_path(
    path: str | None,
    artifacts: Sequence[str] | None = None,
) -> bool:
    """Whether a landed path counts as product for files-form gates.

    Every workspace write counts. Missing / empty path → ``True`` (compat for
    ``ToolAttempt`` without ``meta.path``). ``artifacts`` is retained for
    call-site compatibility and is not consulted.
    """
    _ = artifacts
    return True


def filter_product_landing_paths(
    paths: Sequence[str],
    artifacts: Sequence[str] | None = None,
) -> list[str]:
    """Keep non-empty landed paths (stable order). ``artifacts`` unused (compat)."""
    _ = artifacts
    out: list[str] = []
    for raw in paths:
        if not raw or not str(raw).strip():
            continue
        out.append(str(raw))
    return out


def _relpath_from_arg(raw: object) -> str | None:
    if not isinstance(raw, str):
        return None
    cleaned = raw.strip().replace("\\", "/")
    if not cleaned:
        return None
    return sanitize_write_relpath(cleaned)


def _batch_landing_path(args: dict) -> str | None:
    ops = args.get("operations")
    if not isinstance(ops, list):
        return None
    for item in ops:
        if not isinstance(item, dict):
            continue
        op = str(item.get("op") or "").strip()
        if op in {"move", "copy"}:
            path = _relpath_from_arg(item.get("destination"))
            if path:
                return path
        elif op in {"delete", "mkdir"}:
            path = _relpath_from_arg(item.get("path"))
            if path:
                return path
    return None


def landing_tool_path_from_args(tool_name: str, args: dict | None) -> str | None:
    """A landing tool's TARGET path, read off its call arguments.

    This is attempt-level metadata (``ToolAttempt.meta.path``) for governance that runs
    when there is no successful result to read — same-path write-reject streaks, denied
    calls, liveness timeouts. It is **not** the delivery ledger: what a run produced
    comes from the tool's own self-report (``ToolResult.file_products``), never from
    arguments. ``file_batch`` reads the first operation's destination / path;
    ``write`` / ``edit`` name ``file_path``. :func:`sanitize_write_relpath` keeps this aligned
    with what the write tools actually land on disk.
    """
    if not isinstance(args, dict) or tool_name not in LANDING_TOOLS:
        return None
    if tool_name == "file_batch":
        return _batch_landing_path(args)
    return _relpath_from_arg(args.get("file_path"))
