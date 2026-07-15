"""Demo tape schema + constants (dev-only product-demo screen recording)."""

from __future__ import annotations

from typing import Any

# Reserved key inside TeamPreviewSuspension.debate_arguments so resume can divert
# to the tape player without a new suspension kind / packages/ contract change.
DEMO_TAPE_FRAME_KEY = "__demo_tape__"

TAPE_FORMAT_VERSION = 1

# Live pause cards — player stops here and waits for a real frontend resolve.
PAUSE_REQUIRED_KINDS = frozenset(
    {
        "team_preview_required",
        "checkpoint_required",
        "plan_review_required",
    }
)

# Recorded resolve events are skipped; the live resolve is emitted fresh.
PAUSE_RESOLVED_KINDS = frozenset(
    {
        "team_preview_resolved",
        "checkpoint_resolved",
        "plan_review_resolved",
    }
)

# Projection / execution-only rows — not live SSE.
_SKIP_KIND_PREFIXES = ("process_", "run_process_")
_SKIP_KINDS = frozenset(
    {
        "turn_end",
        "message_final",
        "turn_started",
        "round_boundary",
        "llm_call",
        "tool_call",
        "note",
        "plan_snapshot",
        "run_final",
    }
)

# Delta kinds that benefit from typing-feel re-chunking on export.
CHUNKABLE_DELTA_KINDS = frozenset(
    {
        "run_output_delta",
        "run_reasoning_delta",
        "content_delta",
        "reasoning_delta",
    }
)


def should_export_kind(kind: str) -> bool:
    if not kind or kind in _SKIP_KINDS:
        return False
    if kind.startswith(_SKIP_KIND_PREFIXES):
        return False
    if kind in PAUSE_RESOLVED_KINDS:
        return False
    return True


def parse_iso_ms(ts: str | None) -> int | None:
    """Parse journal ``ts`` (ISO-8601 / ``…Z``) to epoch milliseconds, or None."""
    if not ts:
        return None
    raw = ts.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        from datetime import datetime

        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return int(dt.timestamp() * 1000)


def chunk_text(text: str, *, size: int = 28) -> list[str]:
    """Split ``text`` into typing-sized pieces (CJK-friendly; prefer newline boundaries).

    Joining the parts is always byte-identical to ``text``. When a window would cut
    mid-line, prefer breaking at the last ``\\n`` inside the window so Markdown tables
    stay row-aligned during streaming (fixed-width cuts alone look fine after join but
    tear tables mid-row while typing).
    """
    if not text:
        return []
    if size < 1:
        return [text]
    parts: list[str] = []
    i = 0
    n = len(text)
    while i < n:
        end = min(i + size, n)
        if end < n:
            window = text[i:end]
            nl = window.rfind("\n")
            # Only snap to newline when it yields a meaningful piece (avoid 1-char drips).
            if nl >= max(1, size // 4):
                end = i + nl + 1
        parts.append(text[i:end])
        i = end
    return parts


def is_demo_tape_frame(frame_or_suspension: Any) -> bool:
    """True when a paused frame / suspension carries the demo-tape marker."""
    if frame_or_suspension is None:
        return False
    args = getattr(frame_or_suspension, "debate_arguments", None)
    if isinstance(args, dict) and DEMO_TAPE_FRAME_KEY in args:
        return True
    if isinstance(frame_or_suspension, dict):
        nested = frame_or_suspension.get("debate_arguments") or {}
        if isinstance(nested, dict) and DEMO_TAPE_FRAME_KEY in nested:
            return True
        extras = frame_or_suspension.get(DEMO_TAPE_FRAME_KEY)
        if extras is not None:
            return True
    return False
