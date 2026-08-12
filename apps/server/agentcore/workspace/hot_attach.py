"""Same-turn hot attach of conversation external mounts onto a live backend.

Turn entry (``build_turn_backend``) and ``external_mount_readonly`` after a
successful ClientTool mint both call :func:`attach_grants_to_backend` so
``file_read external/…`` works without waiting for the next resume.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.workspace import grant_store
from agentcore.workspace.external_mounts import ExternalMount
from agentcore.workspace.protocol import WorkspaceBackend

if TYPE_CHECKING:
    from agentcore.desktop.channel import DesktopClientChannel
    from agentcore.workspace.channel import WorkspaceChannel


def _ensure_external_channel(
    backend: WorkspaceBackend,
    *,
    conversation_id: str,
    mounts: dict[str, ExternalMount],
    desktop_channel: DesktopClientChannel | None,
    workspace_channel: WorkspaceChannel | None,
) -> None:
    """Attach a desktop WorkspaceChannel when any grant is root_id-only."""
    if not any(not m.abs_path for m in mounts.values()):
        return
    if getattr(backend, "_external_bridge", None) is not None:
        # Bridge already present — attach_external_mounts refreshed mounts on it.
        return
    attach_ch = getattr(backend, "attach_external_channel", None)
    if not callable(attach_ch):
        return

    ch = workspace_channel
    if ch is None and desktop_channel is not None:
        from agentcore.config import settings
        from agentcore.workspace.channel import WorkspaceChannel

        ch = WorkspaceChannel(
            user_id=desktop_channel.user_id,
            conversation_id=conversation_id,
            registry=desktop_channel.registry,
            timeout_seconds=settings.workspace_op_timeout_seconds,
            root_id="",
            max_inflight=settings.workspace_channel_max_inflight,
        )
    if ch is not None:
        attach_ch(ch)


async def attach_grants_to_backend(
    backend: WorkspaceBackend,
    conversation_id: str,
    *,
    desktop_channel: DesktopClientChannel | None = None,
    workspace_channel: WorkspaceChannel | None = None,
) -> dict[str, ExternalMount]:
    """Load grants for ``conversation_id`` and attach them to ``backend`` (hot).

    Ensures a cloud / root_id-only bridge via ``desktop_channel`` or an existing
    ``workspace_channel`` (sidecar terminal channel) when needed.
    """
    mounts = await grant_store.grants_as_dict(conversation_id)
    attach = getattr(backend, "attach_external_mounts", None)
    if mounts and callable(attach):
        attach(mounts)
        _ensure_external_channel(
            backend,
            conversation_id=conversation_id,
            mounts=mounts,
            desktop_channel=desktop_channel,
            workspace_channel=workspace_channel,
        )
    return mounts
