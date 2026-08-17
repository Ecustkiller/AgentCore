"""Process-wide IndexManager / IndexMaintainer registry, keyed by **index dir**.

Every caller registers under the directory that actually holds ``code_search.db``:
``ServerWorkspace`` passes :attr:`ServerWorkspace.index_dir` (in-tree
``<root>/AgentCore/index`` for local / sidecar, an out-of-tree id-keyed dir for
cloud folders), and ``LocalWorkspace`` passes its host cache under
``data_dir/code_index/<root_id>/<base_digest>``.

Keying on the index dir rather than the workspace root is what keeps a cloud
folder rename from opening a *second* SQLite handle on the same database — the
visible path moves, the id-keyed index dir does not.

Sidecar turns build a fresh ``ServerWorkspace`` each time; without a shared
maintainer, concurrent ``schedule`` calls cannot coalesce across turns.
Warm RPC and write / ``code_search`` kicks share the same entries.

Local turns likewise need one manager per ``root_id`` + ``base_digest`` cache
dir so overlapping PAUSED flush and a new turn do not open two SQLite handles.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING

from agentcore.workspace.indexing.maintainer import IndexMaintainer
from agentcore.workspace.indexing.manager import IndexManager

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend

_managers: dict[str, IndexManager] = {}
_maintainers: dict[str, IndexMaintainer] = {}


def index_dir_key(index_dir: Path | str) -> str:
    """Canonical registry key for a host-side index directory."""
    return str(Path(index_dir).resolve())


def shared_index_manager_for_dir(index_dir: Path | str) -> IndexManager:
    """Return the process-wide ``IndexManager`` for ``index_dir`` (create on miss)."""
    key = index_dir_key(index_dir)
    manager = _managers.get(key)
    if manager is None:
        manager = IndexManager(key)
        _managers[key] = manager
    return manager


def shared_index_maintainer_for_dir(
    index_dir: Path | str, backend: WorkspaceBackend
) -> IndexMaintainer:
    """Return the process-wide ``IndexMaintainer`` for ``index_dir``.

    Rebinds ``backend`` on every call (same index cache; mounts / channel may
    differ per turn). In-flight ``ensure_index`` keeps the backend reference it
    was started with; follow-up coalesced runs use the rebound backend.
    """
    key = index_dir_key(index_dir)
    maintainer = _maintainers.get(key)
    if maintainer is None:
        maintainer = IndexMaintainer(shared_index_manager_for_dir(index_dir), backend)
        _maintainers[key] = maintainer
    else:
        maintainer.bind_backend(backend)
    return maintainer


async def drop_index_registry(index_dir: Path | str) -> None:
    """Drop manager + maintainer for a registry key so the index dir can be removed.

    Lets in-flight maintenance **finish** (``settle``) before releasing the handle:
    ``ensure_index`` runs in a worker thread, so cancelling it returns while the
    thread still holds ``code_search.db`` open. Required on Windows before ``rmtree``
    of the index dir (WinError 32 sharing violation).
    """
    key = index_dir_key(index_dir)
    maintainer = _maintainers.pop(key, None)
    if maintainer is not None:
        await maintainer.settle()
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


async def drain_index_registry() -> None:
    """Abort in-flight maintenance and drop all entries (tests only).

    ``clear_index_registry`` only cancels; the cancelled ``code-index-maintain``
    task can still resume into ``asyncio.to_thread`` after pytest-asyncio shuts
    the function-scoped loop's default executor
    (``RuntimeError: Executor shutdown has been called``). Await here while the
    loop is still alive.
    """
    pending: list[asyncio.Task[None]] = []
    for maintainer in list(_maintainers.values()):
        task = maintainer.abort()
        if task is not None:
            pending.append(task)
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)
    clear_index_registry()
