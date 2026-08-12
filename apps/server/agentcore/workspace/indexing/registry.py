"""Process-wide IndexManager / IndexMaintainer registry.

Two entry styles share the same process dicts (keys are distinct path shapes):

* **Workspace root** (``ServerWorkspace`` / sidecar): ``shared_index_manager`` /
  ``shared_index_maintainer`` → ``IndexManager.for_workspace_root``.
* **Index directory** (``LocalWorkspace`` host cache under ``data_dir/code_index``):
  ``shared_index_manager_for_dir`` / ``shared_index_maintainer_for_dir`` →
  ``IndexManager(index_dir)``.

Sidecar turns build a fresh ``ServerWorkspace`` each time; without a shared
maintainer, concurrent ``schedule`` calls cannot coalesce across turns.
Warm RPC and write / ``code_search`` kicks share the same entries.

Local turns likewise need one manager per ``root_id`` + ``base_digest`` cache
dir so overlapping PAUSED flush and a new turn do not open two SQLite handles.
"""

from __future__ import annotations

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


def index_dir_key(index_dir: Path | str) -> str:
    """Canonical registry key for a host-side index directory."""
    return str(Path(index_dir).resolve())


def shared_index_manager(root: Path | str) -> IndexManager:
    """Return the process-wide ``IndexManager`` for ``root`` (create on miss)."""
    key = root_key(root)
    manager = _managers.get(key)
    if manager is None:
        manager = IndexManager.for_workspace_root(key)
        _managers[key] = manager
    return manager


def shared_index_manager_for_dir(index_dir: Path | str) -> IndexManager:
    """Return the process-wide ``IndexManager`` for ``index_dir`` (create on miss).

    Used by ``LocalWorkspace`` where the BM25 DB lives under
    ``data_dir/code_index/<root_id>/<base_digest>`` rather than beside a disk root.
    """
    key = index_dir_key(index_dir)
    manager = _managers.get(key)
    if manager is None:
        manager = IndexManager(key)
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


async def drop_index_registry(root_or_index_dir: Path | str) -> None:
    """Drop manager + maintainer for a registry key so the index dir can be removed.

    ``root_or_index_dir`` is whatever key style was used to register: a workspace
    root (Server) or a host ``code_index`` cache directory (Local).

    Lets in-flight maintenance **finish** (``settle``) before releasing the handle:
    ``ensure_index`` runs in a worker thread, so cancelling it returns while the
    thread still holds ``code_search.db`` open. Required on Windows before ``rmtree``
    of the index dir (WinError 32 sharing violation).
    """
    # Both entry styles resolve the path the same way; one pop covers either key.
    key = root_key(root_or_index_dir)
    maintainer = _maintainers.pop(key, None)
    if maintainer is not None:
        await maintainer.settle()
    manager = _managers.pop(key, None)
    if manager is not None:
        manager.release()


def clear_index_registry() -> None:
    """Drop all registry entries (tests only) — root keys and index-dir keys."""
    for maintainer in list(_maintainers.values()):
        maintainer.abort()
    for manager in list(_managers.values()):
        manager.release()
    _managers.clear()
    _maintainers.clear()
