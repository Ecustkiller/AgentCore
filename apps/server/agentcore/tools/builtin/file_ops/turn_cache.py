"""Helpers for turn-scoped read-only tool result cache."""

from __future__ import annotations

import json
import time
from dataclasses import replace
from typing import Any

from agentcore.tools.protocol import ToolContext, ToolResult


def key_from_parts(*parts: Any) -> str:
    """Stable cache key for normalized tool arguments."""
    return json.dumps(parts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def cached_tool_result(
    cached: ToolResult,
    start: float,
    *,
    kind: str,
) -> ToolResult:
    """Clone a cached result with hit metrics and this call's wall time."""
    metadata = dict(cached.metadata or {})
    metadata["turn_cache_hit"] = True
    metadata["turn_cache_kind"] = kind
    metadata["turn_cache_saved_chars"] = len(cached.output or "")
    return replace(
        cached,
        duration_ms=int((time.monotonic() - start) * 1000),
        metadata=metadata,
        citations=list(cached.citations) if cached.citations else None,
        display=dict(cached.display) if cached.display else None,
    )


def cache_success(
    context: ToolContext,
    *,
    kind: str,
    key: str,
    result: ToolResult,
    backend: object,
    max_chars: int,
    allow_display: bool = False,
    max_display_chars: int = 0,
    cache_failure: bool = False,
    fingerprint: Any | None = None,
) -> None:
    """Store one completed result when it still belongs to the original backend.

    Ordinary read-only tools cache success only. Verification opts into completed
    red results (`cache_failure=True`) because a finished failing check is just as
    reusable as a green one until the workspace changes.
    """
    display_chars = 0
    if result.display:
        if not allow_display:
            return
        try:
            display_chars = len(
                json.dumps(result.display, ensure_ascii=False, default=str)
            )
        except (TypeError, ValueError):
            return
        if max_display_chars <= 0 or display_chars > max_display_chars:
            return

    if (
        (not result.success and not cache_failure)
        or context.backend is not backend
        or len(result.output or "") > max_chars
        or result.spill_source is not None
    ):
        return
    context.cache_tool_result(
        kind=kind,
        key=key,
        value=replace(
            result,
            tool_call_id="",
            metadata=dict(result.metadata or {}),
        ),
        fingerprint=fingerprint,
    )
