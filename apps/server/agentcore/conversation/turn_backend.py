"""Pick a turn's workspace backend (cloud / local)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from agentcore.runtime.events import EventSink
from agentcore.shared_spaces.types import SharedMountMode
from agentcore.workspace import grant_store, shared_mount_store
from agentcore.workspace.hot_attach import attach_grants_to_backend
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend


def build_shared_access_hooks(
    *,
    user_id: str,
) -> tuple[
    Callable[[str], Awaitable[SharedMountMode | None]],
    Callable[[str, str, str], Awaitable[None]],
]:
    """Build per-turn shared-mount gate + mutation hook (opens a fresh DB session)."""

    async def gate(space_id: str) -> SharedMountMode | None:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import (
            UserBlockRepository,
            UserDirectoryRepository,
            UserRepository,
        )
        from agentcore.db.repositories.shared_spaces import SharedSpaceRepository
        from agentcore.messaging.hub import HubChatEventPublisher, default_chat_hub
        from agentcore.shared_spaces.service import SharedSpaceService

        async with async_session_factory() as session:
            service = SharedSpaceService(
                spaces=SharedSpaceRepository(session),
                users=UserRepository(session),
                blocks=UserBlockRepository(session),
                directory=UserDirectoryRepository(session),
                events=HubChatEventPublisher(default_chat_hub()),
            )
            access = await service.resolve_mount_access(
                space_id=space_id, user_id=user_id
            )
            return access.mode if access else None

    async def on_mutation(space_id: str, action: str, path: str) -> None:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import (
            UserBlockRepository,
            UserDirectoryRepository,
            UserRepository,
        )
        from agentcore.db.repositories.shared_spaces import SharedSpaceRepository
        from agentcore.messaging.hub import HubChatEventPublisher, default_chat_hub
        from agentcore.shared_spaces.service import SharedSpaceService

        async with async_session_factory() as session:
            service = SharedSpaceService(
                spaces=SharedSpaceRepository(session),
                users=UserRepository(session),
                blocks=UserBlockRepository(session),
                directory=UserDirectoryRepository(session),
                events=HubChatEventPublisher(default_chat_hub()),
            )
            await service.record_file_change(
                space_id=space_id,
                actor_user_id=user_id,
                actor_via="agent",
                action=action,
                path=path,
            )

    return gate, on_mutation


async def build_turn_backend(
    *,
    user_id: str,
    conversation_id: str,
    folder_id: str | None,
    sink: EventSink,
    local_binding: LocalBinding | None,
    shared_gate: Callable[[str], Awaitable[SharedMountMode | None]] | None = None,
    on_shared_mutation: Callable[[str, str, str], Awaitable[None]] | None = None,
) -> WorkspaceBackend:
    """Pick a turn's workspace backend: local when bound, else cloud.

    Project conversations pass ``folder_id`` so cloud mode shares ``folder:<id>``;
    裸聊 passes ``folder_id=None`` for per-conversation ``conv:<id>`` scratch.

    Attaches W3 conversation-scoped external mounts and shared-space second roots
    when grants exist. ``shared_gate`` re-checks membership/role on each shared file op.
    """
    backend = build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )
    # Cloud root_id-only grants: build a channel from sink so external/ ops reach desktop.
    # (Same helper mid-turn ``external_mount_readonly`` uses after a silent mint.)
    from agentcore.config import settings
    from agentcore.runtime.interaction import default_interaction_registry
    from agentcore.workspace.channel import WorkspaceChannel

    bootstrap_ch: WorkspaceChannel | None = None
    grants = await grant_store.grants_as_dict(conversation_id)
    if grants and getattr(backend, "location", None) == "server" and any(
        not m.abs_path for m in grants.values()
    ):
        bootstrap_ch = WorkspaceChannel(
            sink=sink,
            conversation_id=conversation_id,
            registry=default_interaction_registry(),
            timeout_seconds=settings.workspace_op_timeout_seconds,
            root_id="",
            max_inflight=settings.workspace_channel_max_inflight,
        )
    await attach_grants_to_backend(
        backend,
        conversation_id,
        workspace_channel=bootstrap_ch,
    )

    shared = shared_mount_store.mounts_as_dict(conversation_id)
    if shared:
        if shared_gate is None or on_shared_mutation is None:
            shared_gate, on_shared_mutation = build_shared_access_hooks(user_id=user_id)
        attach_shared = getattr(backend, "attach_shared_mounts", None)
        if callable(attach_shared):
            attach_shared(shared, gate=shared_gate, on_mutation=on_shared_mutation)
    # Code-index maintenance is kicked from write paths / code_search only —
    # not at turn entry (keeps TTFT / first thinking packet off the index path).
    # A′ write-lock short waits: emit workspace_lock_wait so desktop never fakes Thinking…
    bind_wait = getattr(backend, "set_lock_waiting_hook", None)
    if callable(bind_wait):

        def _on_lock_waiting(waiting: bool) -> None:
            if sink._closed:
                return
            from agentcore.runtime.events import workspace_lock_wait

            sink.emit(
                workspace_lock_wait(conversation_id=conversation_id, waiting=waiting)
            )

        bind_wait(_on_lock_waiting)
    return backend
