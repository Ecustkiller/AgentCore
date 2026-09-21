"""Declared workspace directories that may be listed before they exist on disk.

Authority (no name heuristics)::

    - ``stage_dirs.AGENTCORE_ROOT`` — the ``AgentCore/`` workroom root
    - ``attachments.ATTACHMENTS_DIR`` — resident attachment root (exact or under)

Writes already ``mkdir(parents=True)`` into these trees; listing a missing path
here is a latent empty dir, not a path-guess failure. Arbitrary missing paths
outside this set still raise ``NotADirectory`` / ``PathNotFound``.
"""

from __future__ import annotations

from agentcore.workspace.attachments import ATTACHMENTS_DIR
from agentcore.workspace.stage_dirs import AGENTCORE_ROOT

_DECLARED_EXACT: frozenset[str] = frozenset({AGENTCORE_ROOT, ATTACHMENTS_DIR})

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
    ``AgentCore/`` itself is latent-empty; its children (rules / 记忆 / leftover
    文档) are ordinary paths and must exist on disk to list.
    """
    p = normalize_workspace_relpath(rel_path)
    if not p or p == ".":
        return False
    if p in _DECLARED_EXACT:
        return True
    return p.startswith(_ATTACHMENTS_PREFIX)
