"""Assistant deliverable prose prep (leaf; db + conversation + runtime).

Strip vendor / DSML tool-protocol residue and apply the persistence length ceiling
**before** assistant rows land in the DB. Pure text helpers — no runtime / tool
seams. Tool-name / args / handoff salvage stay in
``runtime.engine.tool_protocol_sanitize`` (re-exports these symbols for compat).
"""

from __future__ import annotations

import re

__all__ = [
    "ASSISTANT_CONTENT_MAX_CHARS",
    "ASSISTANT_CONTENT_OVERSIZE_FACE",
    "prepare_assistant_content",
    "sanitize_protocol_text",
    "truncate_at_dsml_open",
]

# Persist ceiling after protocol strip (pathological DSML walls were multi-MB).
ASSISTANT_CONTENT_MAX_CHARS = 200_000
# Short error face when cleaned prose still exceeds the ceiling.
ASSISTANT_CONTENT_OVERSIZE_FACE = "助手回复过长或含无法展示的协议内容，已省略。请重试。"

# Vendor / generic tool-protocol tags (open or close), optionally with attrs.
# Includes bare structural wrappers (``object`` / ``list`` / ``item``) seen when
# XML-style tool calling leaks into JSON arguments.
_PROTOCOL_TAG_RE = re.compile(
    r"</?"
    r"(?:longcat_)?"
    r"(?:arg_key|arg_value|tool_call|tool_name|parameter|arguments?|function|"
    r"object|list|item|invoke|tool)"
    r"(?:\s[^>]*)?>",
    re.IGNORECASE,
)

# DeepSeek DSML (fullwidth ``｜`` U+FF5C) — not matched by ``_PROTOCOL_TAG_RE``.
_DSML_OPEN_MARKER = "<｜DSML｜"
# Well-formed named element with matching close (parameter / invoke / tool_calls).
_DSML_CLOSED_BLOCK_RE = re.compile(
    r"<｜DSML｜(tool_calls|invoke|parameter)\b[^>]*>"
    r".*?"
    r"</｜DSML｜\1\s*>",
    re.DOTALL | re.IGNORECASE,
)
# Truncated close (missing ``>``) then blank line — model resumes real prose.
_DSML_TRUNC_CLOSE_RESUME_RE = re.compile(
    r"</｜DSML｜\w+\s*\n\s*\n(?!<｜DSML｜)",
)
# Orphan open/close tags (including truncated closes without ``>``).
_DSML_TAG_RE = re.compile(r"</?｜DSML｜[^>\n]*>?", re.IGNORECASE)


def truncate_at_dsml_open(text: str) -> str:
    """Keep only prose before the first DSML open tag (cancel / abort salvage)."""
    if not text:
        return text
    idx = text.find(_DSML_OPEN_MARKER)
    if idx < 0:
        return text
    return text[:idx]


def _strip_dsml_protocol(text: str) -> str:
    """Remove DSML tool-call blocks; keep surrounding natural language."""
    if _DSML_OPEN_MARKER not in text and "｜DSML｜" not in text:
        return text

    cleaned = text
    prev = None
    while prev != cleaned:
        prev = cleaned
        cleaned = _DSML_CLOSED_BLOCK_RE.sub("", cleaned)

    idx = cleaned.find(_DSML_OPEN_MARKER)
    if idx >= 0:
        before = cleaned[:idx]
        after = cleaned[idx:]
        m = _DSML_TRUNC_CLOSE_RESUME_RE.search(after)
        cleaned = (
            before + _strip_dsml_protocol(after[m.end() :]) if m is not None else before
        )

    cleaned = _DSML_TAG_RE.sub("", cleaned)
    return cleaned


def sanitize_protocol_text(text: str) -> str:
    """Remove protocol tags from free text; collapse leftover whitespace runs lightly."""
    if not text:
        return text
    cleaned = _strip_dsml_protocol(text)
    cleaned = _PROTOCOL_TAG_RE.sub("", cleaned)
    # Do not strip all ``<>`` from prose (may contain comparisons); only collapse
    # whitespace left by removed tags.
    if cleaned != text:
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned


def prepare_assistant_content(text: str, *, salvage: bool = False) -> str:
    """Sanitize assistant deliverable prose for persistence / loop exit.

    When ``salvage`` is True (user_stop / incomplete / abort), truncate at the first
    DSML open tag before strip + length ceiling — unfinished tool XML is never kept.
    """
    if not text:
        return text
    body = truncate_at_dsml_open(text) if salvage else text
    cleaned = sanitize_protocol_text(body)
    if len(cleaned) > ASSISTANT_CONTENT_MAX_CHARS:
        return ASSISTANT_CONTENT_OVERSIZE_FACE
    return cleaned
