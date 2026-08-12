"""Folder binding lookup, claim book, and target WorkspaceBackend construction."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.delegate.target_desktop_gate import TargetDesktopError
from agentcore.workspace.locate import LocalBinding, build_workspace
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


@dataclass(frozen=True)
class TargetFolderBinding:
    """Resolved Folder row bits needed to build a worker desk."""

    folder_id: str
    name: str
    local_binding: LocalBinding | None


class LocalRootClaimBook:
    """Turn-scoped registry of local ``root_id`` values (C0: never rejects)."""

    def __init__(self) -> None:
        self._roots: set[str] = set()
        self._lock = asyncio.Lock()

    async def try_claim(self, root_id: str) -> bool:
        """Record ``root_id`` for this turn; always allows distinct roots (C0)."""
        async with self._lock:
            self._roots.add(root_id)
            return True

    async def seed_from_backend(self, backend: WorkspaceBackend) -> None:
        """Record the turn's primary local root (if any) before alien desks claim."""
        root = backend_local_root_id(backend)
        if root:
            await self.try_claim(root)


async def load_target_folder_binding(
    *,
    folder_id: str,
    user_id: str,
) -> TargetFolderBinding | None:
    """Owner-scoped Folder lookup → binding for ``build_workspace``.

    Returns ``None`` when the folder is missing or not owned (business miss).
    Raises ``TargetDesktopError`` when PostgreSQL is unreachable **or** when
    folders cloud credentials are bound but the cloud HTTP call fails — honest
    failure, no local-cache fallback and no forged ``local_binding``.

    With folders narrow-ticket credentials (sidecar), uses cloud ``GET /folders/{id}``
    instead of the local FolderRepository.
    """
    from agentcore.conversation.scratch import resolve_conversation_local_binding
    from agentcore.folders.credentials import (
        FoldersCloudError,
        cloud_get_folder,
        get_folders_credentials,
    )

    creds = get_folders_credentials()
    if creds is not None:
        try:
            summary = await cloud_get_folder(creds, folder_id=folder_id)
        except FoldersCloudError as e:
            logger.warning(
                "delegate.target_folder_cloud_failed",
                folder_id=folder_id,
                user_id=user_id,
                error=str(e),
                code=e.code,
            )
            raise TargetDesktopError(f"无法绑定目标项目。{e.message}") from e
        if summary is None:
            return None
        binding = resolve_conversation_local_binding(
            local_root_id=summary.get("local_root_id"),
            local_subpath=summary.get("local_subpath"),
            label=str(summary.get("name") or "workspace"),
        )
        return TargetFolderBinding(
            folder_id=str(summary.get("id") or folder_id),
            name=str(summary.get("name") or ""),
            local_binding=binding,
        )

    from agentcore.db.base import async_session_factory
    from agentcore.db.errors import DATABASE_UNAVAILABLE_MESSAGE, is_db_connectivity_error
    from agentcore.db.repositories import FolderRepository

    try:
        async with async_session_factory() as session:
            folder = await FolderRepository(session).get_by_id(folder_id, user_id=user_id)
            if folder is None:
                return None
            binding = resolve_conversation_local_binding(
                local_root_id=folder.local_root_id,
                local_subpath=folder.local_subpath,
                label=folder.name or "workspace",
            )
            return TargetFolderBinding(
                folder_id=folder.id,
                name=folder.name or "",
                local_binding=binding,
            )
    except Exception as e:  # noqa: BLE001 — classify connectivity vs bubble
        if is_db_connectivity_error(e):
            logger.warning(
                "delegate.target_folder_db_unreachable",
                folder_id=folder_id,
                user_id=user_id,
                error=str(e),
            )
            raise TargetDesktopError(f"无法绑定目标项目。{DATABASE_UNAVAILABLE_MESSAGE}") from e
        raise


async def lookup_folder_display_names(
    folder_ids: set[str],
    *,
    user_id: str,
) -> dict[str, str]:
    """Soft owner-scoped Folder id → display name map for kickoff card projection.

    Reuses :func:`load_target_folder_binding` (cloud ticket / local DB). Misses and
    connectivity failures are omitted from the map — callers stamp a fallback label.
    Never raises; kickoff must not block on name resolution.
    """
    cleaned = {fid.strip() for fid in folder_ids if isinstance(fid, str) and fid.strip()}
    uid = (user_id or "").strip()
    if not cleaned or not uid:
        return {}

    async def _one(fid: str) -> tuple[str, str] | None:
        try:
            binding = await load_target_folder_binding(folder_id=fid, user_id=uid)
        except TargetDesktopError:
            return None
        except Exception:  # noqa: BLE001 — soft: never fail kickoff on name lookup
            logger.warning(
                "delegate.folder_display_name_failed",
                folder_id=fid,
                user_id=uid,
            )
            return None
        if binding is None:
            return None
        return fid, binding.name or ""

    pairs = await asyncio.gather(*(_one(fid) for fid in cleaned))
    out: dict[str, str] = {}
    for item in pairs:
        if item is None:
            continue
        fid, name = item
        out[fid] = name
    return out


def build_target_backend(
    *,
    user_id: str,
    folder_id: str,
    conversation_id: str,
    sink: Any,
    local_binding: LocalBinding | None,
) -> WorkspaceBackend:
    """Build a worker desk for ``folder_id`` without touching session binding."""
    return build_workspace(
        user_id=user_id,
        folder_id=folder_id,
        conversation_id=conversation_id,
        sink=sink,
        local_binding=local_binding,
    )


def backend_local_root_id(backend: WorkspaceBackend) -> str | None:
    """Extract local ``root_id`` from a local WorkspaceBackend, else ``None``."""
    if getattr(backend, "location", None) != "local":
        return None
    channel = getattr(backend, "_channel", None)
    root_id = getattr(channel, "root_id", None) if channel is not None else None
    if isinstance(root_id, str) and root_id.strip():
        return root_id.strip()
    return None
