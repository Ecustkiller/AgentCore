"""Pick a turn's workspace backend (cloud / local)."""

from agentcore.runtime.events import EventSink
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend


def build_turn_backend(
    *,
    user_id: str,
    conversation_id: str,
    folder_id: str | None,
    sink: EventSink,
    local_binding: LocalBinding | None,
) -> WorkspaceBackend:
    """Pick a turn's workspace backend: local when bound, else cloud.

    Project conversations pass ``folder_id`` so cloud mode shares ``folder:<id>``;
    裸聊 passes ``folder_id=None`` for per-conversation ``conv:<id>`` scratch.
    """
    return build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )
