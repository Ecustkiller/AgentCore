"""Live folder-hung 文档 (creation tool) — markdown body, not the memory ``documents`` tree."""

from agentcore.doc.body import MAX_MARKDOWN_CHARS, empty_body, sanitize_body
from agentcore.doc.share import freeze_share_snapshot, render_doc_share_html

__all__ = [
    "MAX_MARKDOWN_CHARS",
    "empty_body",
    "freeze_share_snapshot",
    "render_doc_share_html",
    "sanitize_body",
]
