"""Markdown body for the creation-tool 文档 (not the memory ``documents`` tree).

The live doc and the published share snapshot both store ``{"markdown": str}``.
The public HTML renderer reads this same shape (``doc.share``).
"""

from __future__ import annotations

from typing import Any

MAX_MARKDOWN_CHARS = 50_000


def empty_body() -> dict[str, str]:
    return {"markdown": ""}


def sanitize_body(raw: Any) -> dict[str, str]:
    """Coerce a write payload into stored markdown. Never raises — garbage is emptied."""
    text = ""
    if isinstance(raw, str):
        text = raw
    elif isinstance(raw, dict):
        md = raw.get("markdown")
        if isinstance(md, str):
            text = md
    text = text.replace("\x00", "")
    if len(text) > MAX_MARKDOWN_CHARS:
        text = text[:MAX_MARKDOWN_CHARS]
    return {"markdown": text}
