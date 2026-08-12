"""LocalWorkspace process-wide code-index registry (index-dir keys)."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from agentcore.runtime.interaction import InteractionRegistry
from agentcore.workspace.channel import WorkspaceChannel
from agentcore.workspace.indexing.registry import (
    clear_index_registry,
    drop_index_registry,
    shared_index_maintainer_for_dir,
    shared_index_manager_for_dir,
)
from agentcore.workspace.local import LocalWorkspace

pytestmark = pytest.mark.anyio

_USER = "user-local-idx-reg"
_CONV = "conv-local-idx-reg"
_ROOT = "root-shared-idx"


def _local(*, root_id: str = _ROOT, base: str = "", conv: str = _CONV) -> LocalWorkspace:
    channel = WorkspaceChannel(
        user_id=_USER,
        conversation_id=conv,
        registry=InteractionRegistry(),
        timeout_seconds=5.0,
        root_id=root_id,
    )
    return LocalWorkspace(channel, base_subpath=base)


async def test_same_root_and_base_share_manager_and_maintainer():
    clear_index_registry()
    try:
        a = _local(conv="c1")
        b = _local(conv="c2")
        assert a._index_cache_dir() == b._index_cache_dir()  # noqa: SLF001

        idx = a._index_cache_dir()  # noqa: SLF001
        manager = shared_index_manager_for_dir(idx)
        manager.ensure_index = AsyncMock(return_value=False)  # type: ignore[method-assign]

        a.start_code_index_maintenance()
        b.start_code_index_maintenance()

        assert a._index_manager is b._index_manager is manager  # noqa: SLF001
        assert a._index_maintainer is b._index_maintainer  # noqa: SLF001
        assert a._index_maintainer is shared_index_maintainer_for_dir(idx, b)  # noqa: SLF001

        await a._index_maintainer.drain()  # noqa: SLF001
    finally:
        clear_index_registry()


async def test_different_base_do_not_share_index_handles():
    clear_index_registry()
    try:
        root = _local(base="")
        nested = _local(base="apps/desktop", conv="c-nested")
        assert root._index_cache_dir() != nested._index_cache_dir()  # noqa: SLF001

        for ws in (root, nested):
            mgr = shared_index_manager_for_dir(ws._index_cache_dir())  # noqa: SLF001
            mgr.ensure_index = AsyncMock(return_value=False)  # type: ignore[method-assign]
            ws.start_code_index_maintenance()

        assert root._index_manager is not nested._index_manager  # noqa: SLF001
        assert root._index_maintainer is not nested._index_maintainer  # noqa: SLF001

        await root._index_maintainer.drain()  # noqa: SLF001
        await nested._index_maintainer.drain()  # noqa: SLF001
    finally:
        clear_index_registry()


async def test_drop_index_registry_releases_index_dir_entry():
    clear_index_registry()
    try:
        ws = _local()
        idx = ws._index_cache_dir()  # noqa: SLF001
        manager = shared_index_manager_for_dir(idx)
        shared_index_maintainer_for_dir(idx, ws)
        assert ws._get_index_manager() is manager  # noqa: SLF001

        await drop_index_registry(idx)
        # Miss after drop → fresh manager instance for the same dir key.
        assert shared_index_manager_for_dir(idx) is not manager
    finally:
        clear_index_registry()
