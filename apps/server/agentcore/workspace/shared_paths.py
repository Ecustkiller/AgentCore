"""On-disk path helpers for shared spaces (no ServerWorkspace import).

Kept separate from ``locate`` / ``server`` to avoid a circular import: both need
the shared-space root path, and ``locate`` already constructs ``ServerWorkspace``.
"""

from __future__ import annotations

from pathlib import Path

from agentcore.workspace._paths import path_has_non_internal_entries
from agentcore.workspace.layout import (
    SHARED_SEGMENT,
    WORKSPACES_SEGMENT,
    workspaces_base_path,
)


def shared_workspace_root_path(space_id: str) -> Path:
    """On-disk root for a shared space — without creating it."""
    return workspaces_base_path() / SHARED_SEGMENT / space_id


def shared_workspace_has_entries(space_id: str) -> bool:
    """True when the shared space has content outside AgentCore internal zones."""
    return path_has_non_internal_entries(shared_workspace_root_path(space_id))


def shared_workspace_storage_key(space_id: str) -> str:
    """Lock / snapshot key for a shared space (cross-user)."""
    return f"{WORKSPACES_SEGMENT}/{SHARED_SEGMENT}/{space_id}"


def resolve_shared_workspace_root(space_id: str) -> Path:
    root = shared_workspace_root_path(space_id)
    root.mkdir(parents=True, exist_ok=True)
    return root
