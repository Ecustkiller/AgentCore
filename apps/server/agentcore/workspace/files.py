"""Workspace file I/O service — bring user files in and take results out.

The HTTP file-in/out counterpart to the agent's file tools (文件进出·先上传).
It resolves a conversation to its workspace backend (cloud mode today, local
mode later — same seam) and goes through ``WorkspaceBackend`` so upload/download
respect the traversal guard and will route to the desktop unchanged under
``LocalWorkspace``. Path policy lives in ``locate``; this layer never touches a
raw ``Path``.
"""

from __future__ import annotations

from agentcore.workspace.locate import build_server_workspace
from agentcore.workspace.protocol import DirEntry


async def list_files(
    *, user_id: str, folder_id: str | None, conversation_id: str, recursive: bool = False
) -> list[DirEntry]:
    """List entries in the conversation's workspace (top level or recursive)."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    pattern = "**/*" if recursive else "*"
    return await backend.list(".", pattern)


async def upload_file(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str, data: bytes
) -> int:
    """Write ``data`` to ``path`` in the conversation's workspace; return bytes."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.write_bytes(path, data)


async def download_file(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str
) -> bytes:
    """Return the raw bytes of ``path`` in the conversation's workspace."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.read_bytes(path)
