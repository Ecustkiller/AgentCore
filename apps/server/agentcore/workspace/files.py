"""Workspace file I/O service — bring user files in and take results out.

The HTTP file-in/out counterpart to the agent's file tools (文件进出·先上传).
It resolves a conversation to its workspace backend (cloud mode today, local
mode later — same seam) and goes through ``WorkspaceBackend`` so upload/download
respect the traversal guard and will route to the desktop unchanged under
``LocalWorkspace``. Path policy lives in ``locate``; this layer never touches a
raw ``Path``.

Panel download is **decoupled** from AI ``read_bytes``: it uses
:meth:`ServerWorkspace.resolve_for_download` with the upload-aligned ceiling, not
``WORKSPACE_READ_MAX_BYTES``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal, NoReturn

from agentcore.config import settings
from agentcore.core.errors import PayloadTooLargeError, ValidationError
from agentcore.workspace.limits import is_file_too_large_detail
from agentcore.workspace.locate import build_server_workspace
from agentcore.workspace.protocol import DirEntry, WorkspaceIOError


async def list_files(
    *, user_id: str, folder_id: str | None, conversation_id: str, recursive: bool = False
) -> list[DirEntry]:
    """List entries in the conversation's workspace (top level or recursive)."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    pattern = "**/*" if recursive else "*"
    return await backend.list(".", pattern)


async def list_file_index(
    *, user_id: str, folder_id: str | None, conversation_id: str
) -> tuple[list[str], bool]:
    """Flat, ignore-pruned, capped file-path list for @ mentions (文件中枢统一 F4).

    Returns ``(paths, truncated)``. Cloud-only by construction — the route gates
    local workspaces with 409 (their files live on the desktop and are indexed
    there). Mirrors the desktop ``fsApi.listFiles`` so @ behaves the same across
    cloud and local.
    """
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.index_files()


async def upload_file(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str, data: bytes
) -> int:
    """Write ``data`` to ``path`` in the conversation's workspace; return bytes."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.write_bytes(path, data)


def raise_http_for_download_io(exc: WorkspaceIOError) -> NoReturn:
    """Map a download-path ``WorkspaceIOError`` to a clear 4xx (never 500).

    Oversized → 413; other I/O → 422. Always raises.
    """
    if is_file_too_large_detail(str(exc)):
        max_bytes = settings.workspace_upload_max_bytes
        raise PayloadTooLargeError(f"文件超出 {max_bytes} 字节的下载上限") from exc
    raise ValidationError(str(exc) or "读取文件失败") from exc


async def resolve_download_file(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    path: str,
    max_bytes: int | None = None,
) -> Path:
    """Resolve ``path`` for HTTP panel download (``FileResponse``).

    Bypasses the AI ``read_bytes`` 5 MiB gate; default ceiling matches upload.
    """
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    ceiling = settings.workspace_upload_max_bytes if max_bytes is None else max_bytes
    return await backend.resolve_for_download(path, max_bytes=ceiling)


async def download_file(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    path: str,
    max_bytes: int | None = None,
) -> bytes:
    """Return the raw bytes of ``path`` via the panel-download capacity path."""
    target = await resolve_download_file(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        path=path,
        max_bytes=max_bytes,
    )
    try:
        return target.read_bytes()
    except OSError as e:
        raise WorkspaceIOError(str(e)) from e


async def create_dir(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str
) -> None:
    """Create directory ``path`` (with parents) in the conversation's workspace."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    await backend.mkdir(path)


async def delete_file(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str
) -> None:
    """Delete ``path`` (file or directory) in the conversation's workspace."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    await backend.delete(path)


async def move_file(
    *, user_id: str, folder_id: str | None, conversation_id: str, src: str, dst: str
) -> None:
    """Move/rename ``src`` to ``dst`` in the conversation's workspace."""
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    await backend.move(src, dst)


async def read_file_for_edit(
    *, user_id: str, folder_id: str | None, conversation_id: str, path: str
) -> tuple[str, int, Literal["lf", "crlf"]]:
    """Read ``path`` for editing: ``(text, mtime_ms, eol)`` — full text + CAS baseline.

    Unlike :func:`resolve_download_file` / :func:`download_file` (raw bytes for
    panel download), this reads the whole text and reports the mtime baseline so
    an in-panel save can do a write-time CAS instead of blind-clobbering a file
    an Agent turn changed.
    """
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.read_for_edit(path)


async def write_file_text(
    *,
    user_id: str,
    folder_id: str | None,
    conversation_id: str,
    path: str,
    content: str,
    baseline_mtime_ms: int,
    eol: Literal["lf", "crlf"],
) -> tuple[bool, int]:
    """Conditionally write editor text to ``path``; ``(ok, mtime_ms)`` (mtime CAS).

    ``ok`` False means a conflict (disk changed since ``baseline_mtime_ms``) and the
    returned mtime is the current disk version. Callers must hold ``workspace_lock``
    so the CAS is atomic against a same-workspace Agent turn.
    """
    backend = build_server_workspace(
        user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
    )
    return await backend.write_text_cas(path, content, baseline_mtime_ms=baseline_mtime_ms, eol=eol)
