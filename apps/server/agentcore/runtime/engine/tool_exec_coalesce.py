"""Same-round parallel ``file_read`` coalesce helpers (path key + fan-out clone)."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from agentcore.tools.protocol import ToolResult


def _file_read_round_coalesce_key(args: dict[str, Any]) -> str | None:
    """Same-round parallel ``file_read`` coalesce key: normalized path only.

    Offset/limit variants still share one underlying read (fan-out); only full
    reads bump ``file_read_counts``. Empty path → no coalesce.
    """
    if not isinstance(args, dict):
        return None
    path = str(args.get("path") or "").strip().replace("\\", "/")
    return path or None


def _clone_tool_result(result: ToolResult, tool_call_id: str) -> ToolResult:
    """Fan-out copy of a shared ``file_read`` result for a sibling tool_call."""
    return replace(
        result,
        tool_call_id=tool_call_id,
        citations=list(result.citations) if result.citations else None,
        metadata=dict(result.metadata) if result.metadata else {},
        display=dict(result.display) if result.display else None,
    )
