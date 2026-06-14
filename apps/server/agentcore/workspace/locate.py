"""Resolve a conversation to its server-side workspace (cloud mode).

Path policy (双模式工作区设计 §七 / 决策③):

- A conversation **in a folder** shares that folder's workspace — the folder is
  the "project", so work accumulates in one place across its conversations:
  ``<data_dir>/workspaces/<user_id>/<folder_id>/``.
- An **ungrouped** conversation gets its own independent workspace so unrelated
  chats never collide: ``<data_dir>/workspaces/<user_id>/conv/<conversation_id>/``.

User-scoped top segment keeps tenants isolated by directory; the traversal guard
inside ``ServerWorkspace`` then prevents escaping the resolved root. IDs are
server-generated UUIDs (not user input), so they are safe path segments.

This is the single place that maps "which conversation" → "which directory";
``conversation/service.py`` calls it and injects the backend into the pipeline.
P2 (local mode) adds the ``local_dir``-bound branch here without touching tools.
"""

from pathlib import Path

from agentcore.config import settings
from agentcore.tools.sandbox.protocol import SandboxProvider
from agentcore.tools.sandbox.subprocess import SubprocessSandbox
from agentcore.workspace.server import ServerWorkspace

_WORKSPACES_SEGMENT = "workspaces"


def _workspaces_base() -> Path:
    return Path(settings.data_dir) / _WORKSPACES_SEGMENT


def _workspace_relpath(*, user_id: str, folder_id: str | None, conversation_id: str) -> str:
    """The conversation's workspace path relative to the workspaces base (POSIX).

    Single source of the folder-vs-ungrouped branch, shared by the on-disk root
    and the snapshot storage key so they can never drift apart.
    """
    if folder_id:
        return f"{user_id}/{folder_id}"
    return f"{user_id}/conv/{conversation_id}"


def resolve_workspace_root(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> Path:
    """Return (creating if needed) the workspace directory for a conversation."""
    relpath = _workspace_relpath(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    root = _workspaces_base() / relpath
    root.mkdir(parents=True, exist_ok=True)
    return root


def workspace_storage_key(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> str:
    """The snapshot storage key for a conversation's workspace.

    Mirrors the on-disk layout under ``data_dir`` (``workspaces/<user>/<folder>``
    or ``workspaces/<user>/conv/<conversation>``) so a snapshot's object-store
    location reads the same as its filesystem location. The StorageProvider adds
    its own top-level prefix (``snapshots/``).
    """
    relpath = _workspace_relpath(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return f"{_WORKSPACES_SEGMENT}/{relpath}"


def build_server_workspace(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    sandbox: SandboxProvider | None = None,
) -> ServerWorkspace:
    """Construct the ``ServerWorkspace`` for a conversation's resolved root."""
    root = resolve_workspace_root(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return ServerWorkspace(root=root, sandbox=sandbox or SubprocessSandbox())
