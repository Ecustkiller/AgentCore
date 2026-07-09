"""Per-conversation scratch workspace helpers (Folder 重构: 对话级文件空间).

Every conversation owns an independent file space. Cloud path:
``workspaces/<user_id>/conv/<conversation_id>/``. Local path:
``<local_root_id>/<local_subpath>/`` (bound on the conversation row).
"""

from agentcore.workspace.locate import LocalBinding


def resolve_conversation_local_binding(
    *,
    local_root_id: str | None,
    local_subpath: str | None = None,
    label: str = "workspace",
) -> LocalBinding | None:
    """Resolve a conversation's scratch local binding from its own columns.

    ``local_root_id`` is an explicit bind; callers may also pass
    ``local_container_root_id`` (desktop local-first intent) via
    ``conversation.common.resolve_local_binding``.
    """
    if not local_root_id:
        return None
    return LocalBinding(
        root_id=local_root_id,
        root_label=label,
        subpath=local_subpath or "",
    )
