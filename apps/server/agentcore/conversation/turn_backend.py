"""Pick a turn's workspace backend (cloud / local)."""

from agentcore.runtime.events import EventSink
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend


def build_turn_backend(
    *,
    user_id: str,
    conversation_id: str,
    sink: EventSink,
    local_binding: LocalBinding | None,
) -> WorkspaceBackend:
    """Pick a turn's workspace backend: local when bound, else cloud.

    Post Folder-refactor: every conversation always has a scratch space
    (folder_id=None forces the conv:<id> path). No more DeferredWorkspace.
    """
    return build_workspace(
        user_id=user_id,
        folder_id=None,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )
