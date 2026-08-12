"""Process-wide IndexManager / IndexMaintainer registry keyed by workspace root.

Sidecar turns build a fresh ``ServerWorkspace`` each time; without a shared
maintainer, concurrent ``schedule`` calls cannot coalesce across turns.
Warm RPC and write / ``code_search`` kicks share the same entries.
"""

from __future__ import annotations

import contextlib
from pathlib import Path
from typing import TYPE_CHECKING

from agentcore.workspace.indexing.maintainer import IndexMaintainer
from agentcore.workspace.indexing.manager import IndexManager

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend

_managers: dict[str, IndexManager] = {}
_maintainers: dict[str, IndexMaintainer] = {}


def root_key(root: Path | str) -> str:
    """Canonical registry key for a local-disk workspace root."""
    return str(Path(root).resolve())


def shared_index_manager(root: Path | str) -> IndexManager:
    """Return the process-wide ``IndexManager`` for ``root`` (create on miss)."""
    key = root_key(root)
    manager = _managers.get(key)
    if manager is None:
        manager = IndexManager.for_workspace_root(key)
        _managers[key] = manager
    return manager


def shared_index_maintainer(root: Path | str, backend: WorkspaceBackend) -> IndexMaintainer:
    """Return the process-wide ``IndexMaintainer`` for ``root``.

    Rebinds ``backend`` on every call so ensure I/O uses the caller's workspace
    (same root; mounts may differ per turn).
    """
    key = root_key(root)
    maintainer = _maintainers.get(key)
    if maintainer is None:
        maintainer = IndexMaintainer(shared_index_manager(root), backend)
        _maintainers[key] = maintainer
    else:
        maintainer.bind_backend(backend)
    return maintainer


async def drop_index_registry(root: Path | str) -> None:
    """Drop manager + maintainer for ``root`` so ``AgentCore/index`` can be removed.

    Aborts in-flight maintenance (awaits cancel so SQLite closes) then releases
    the handle. Required on Windows before ``rmtree`` of the index dir
    (WinError 32 sharing violation).
    """
    import asyncio

    key = root_key(root)
    maintainer = _maintainers.pop(key, None)
    if maintainer is not None:
        task = maintainer.abort()
        if task is not None:
            # CancelledError is BaseException (3.9+); must not leak into the
            # caller's request task or Starlette returns "No response".
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
    manager = _managers.pop(key, None)
    if manager is not None:
        manager.release()


def clear_index_registry() -> None:
    """Drop all registry entries (tests only)."""
    for maintainer in list(_maintainers.values()):
        maintainer.abort()
    for manager in list(_managers.values()):
        manager.release()
    _managers.clear()
    _maintainers.clear()
