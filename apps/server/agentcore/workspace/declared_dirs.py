"""Declared workspace directories that may be listed before they exist on disk.

Authority (no name heuristics)::

    - ``stage_dirs`` — ``AgentCore`` / ``AgentCore/文档`` ancestors, plus
      ``research`` / ``debate`` / ``reviews`` / ``项目`` stage trees (exact or under).
    - ``attachments.ATTACHMENTS_DIR`` — resident attachment root (exact or under).

Writes already ``mkdir(parents=True)`` into these trees; listing a missing path
here is a latent empty dir, not a path-guess failure. Arbitrary missing paths
outside this set still raise ``NotADirectory`` / ``PathNotFound``.
"""

from __future__ import annotations

from agentcore.workspace.attachments import ATTACHMENTS_DIR
from agentcore.workspace.stage_dirs import (
    AGENTCORE_ROOT,
    DEBATE_DIR,
    DEBATE_PREFIX,
    DOCS_PREFIX,
    PROJECT_DOCS_DIR,
    PROJECT_DOCS_PREFIX,
    RESEARCH_DIR,
    RESEARCH_PREFIX,
    REVIEWS_DIR,
    REVIEWS_PREFIX,
)

# Exact ancestors of the stage-docs tree (injected export prefixes).
_DECLARED_EXACT: frozenset[str] = frozenset({AGENTCORE_ROOT, DOCS_PREFIX, ATTACHMENTS_DIR})

# Stage leaf dirs: exact match or descendant under the matching PREFIX.
_DECLARED_STAGE: tuple[tuple[str, str], ...] = (
    (RESEARCH_DIR, RESEARCH_PREFIX),
    (DEBATE_DIR, DEBATE_PREFIX),
    (REVIEWS_DIR, REVIEWS_PREFIX),
    (PROJECT_DOCS_DIR, PROJECT_DOCS_PREFIX),
)

_ATTACHMENTS_PREFIX = f"{ATTACHMENTS_DIR}/"

# AI-facing empty-list copy when a declared dir is not on disk yet.
LATENT_EMPTY_LIST_MESSAGE = "（空目录 · 尚未创建；写入时会自动创建）"

__all__ = [
    "LATENT_EMPTY_LIST_MESSAGE",
    "is_declared_latent_dir",
    "normalize_workspace_relpath",
]


def normalize_workspace_relpath(rel_path: str) -> str:
    """Normalize a workspace-relative path for declared-dir checks."""
    return (rel_path or "").replace("\\", "/").strip("/")


def is_declared_latent_dir(rel_path: str) -> bool:
    """True when ``rel_path`` is a system-declared dir that writes may auto-create.

    Basis is the constant set above only — not generic names like ``src``/``lib``.
    """
    p = normalize_workspace_relpath(rel_path)
    if not p or p == ".":
        return False
    if p in _DECLARED_EXACT:
        return True
    if p.startswith(_ATTACHMENTS_PREFIX):
        return True
    return any(p == exact or p.startswith(prefix) for exact, prefix in _DECLARED_STAGE)
