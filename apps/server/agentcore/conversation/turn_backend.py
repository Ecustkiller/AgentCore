"""Pick a turn's workspace backend (cloud / local / deferred 裸聊)."""

from agentcore.conversation.promotion import bare_chat_promote
from agentcore.runtime.events import EventSink
from agentcore.workspace.deferred import DeferredWorkspace
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend


def build_turn_backend(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    title: str | None,
    sink: EventSink,
    local_binding: LocalBinding | None,
    user_message: str = "",
    local_container_root_id: str | None = None,
) -> WorkspaceBackend:
    """Pick a turn's workspace backend, deferring creation for a 裸聊 (§懒建)."""
    if folder_id is None and local_binding is None:
        return DeferredWorkspace(
            user_id=user_id,
            promote=bare_chat_promote(
                user_id=user_id,
                conversation_id=conversation_id,
                title=title,
                user_message=user_message,
                local_container_root_id=local_container_root_id,
                sink=sink,
            ),
            sink=sink,
            conversation_id=conversation_id,
        )
    return build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )
