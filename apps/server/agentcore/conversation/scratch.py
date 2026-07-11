"""Per-conversation / project workspace helpers (项目即工作区).

Bare chat cloud path: ``workspaces/<user_id>/conv/<conversation_id>/``.
Project cloud path: ``workspaces/<user_id>/<folder_id>/`` (shared by all
conversations in the project). Local path uses the governing binding's
``local_root_id`` / ``local_subpath`` (project row when foldered; conversation
row when bare).
"""

from agentcore.db.models import Conversation
from agentcore.workspace.locate import LocalBinding


def resolve_conversation_local_binding(
    *,
    local_root_id: str | None,
    local_subpath: str | None = None,
    label: str = "workspace",
) -> LocalBinding | None:
    """Build a local binding from root/subpath columns, or None when unbound (cloud)."""
    if not local_root_id:
        return None
    return LocalBinding(
        root_id=local_root_id,
        root_label=label,
        subpath=local_subpath or "",
    )


def conversation_workspace_folder_id(conv: Conversation) -> str | None:
    """Effective folder_id for path/key resolution (project share vs conv scratch)."""
    return conv.folder_id
