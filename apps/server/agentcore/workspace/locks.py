"""Folder-level workspace lock (决策④ / A′: 同 folder 写串行，读/LLM/prepare 可并行).

A workspace (a folder's shared space, or an ungrouped conversation's own space)
serializes **mutating** ops and snapshot-manifest RMW on one key. Concurrent
turns on the same folder may overlap on prepare / LLM / reads; only writes and
snapshot create/restore queue. Intra-task parallelism (a delegated worker team)
is collaboration and is *not* limited here — the lock is taken per write /
snapshot at the sink, not once per whole turn.

``asyncio.Lock`` is **not reentrant**: never nest ``workspace_lock`` on the same
key (no outer half-hold + inner write/snapshot). Whole-turn holders were removed
under A′; sinks are ``ServerWorkspace`` mutations (when ``lock_key`` is set) and
``workspace.snapshots`` create/restore.

Why it matters: same-folder turns share files and the snapshot manifest
read-modify-write (storage/_archive.py) is only safe under this lock. Reads are
intentionally not locked. Conversation compaction is DB-only and must **not**
take this lock (would re-serialize turn open).

When a caller must block on a contended lock **before** the client has visible
progress (e.g. residual kickoff-side writes), pass ``on_waiting`` so SSE can show
honest queue UX — **不得静默等锁**（禁空「Thinking…」冒充）。

The lock registry is keyed by the running event loop (via a ``WeakKeyDictionary``)
so a lock is never reused across loops — robust under pytest's per-test loops,
while production (one loop) keeps exactly one registry. Multi-process scaling
swaps this for a Redis lock behind the same ``workspace_lock`` seam.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager

# loop -> {storage_key: Lock}. WeakKeyDictionary so a finished loop's locks are
# garbage-collected with it (no stale-loop reuse, no id() collisions).
_registries: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]] = (
    weakref.WeakKeyDictionary()
)


def _get_lock(key: str) -> asyncio.Lock:
    """Return the process-wide lock for ``key`` on the current loop (create once).

    Synchronous and free of ``await``, so the get-or-create is atomic within the
    single-threaded event loop — no guard lock needed.
    """
    loop = asyncio.get_running_loop()
    registry = _registries.get(loop)
    if registry is None:
        registry = {}
        _registries[loop] = registry
    lock = registry.get(key)
    if lock is None:
        lock = asyncio.Lock()
        registry[key] = lock
    return lock


@asynccontextmanager
async def workspace_lock(
    key: str,
    *,
    on_waiting: Callable[[bool], None] | None = None,
) -> AsyncIterator[None]:
    """Hold the workspace's folder-level lock for the duration of the block.

    ``key`` is the workspace storage key (``workspace.locate.workspace_storage_key``)
    so all of a folder's conversations serialize writes/snapshots on one lock.
    Do not nest on the same ``key`` — ``asyncio.Lock`` is not reentrant.

    When the lock is already held, ``on_waiting(True)`` fires *before* blocking and
    ``on_waiting(False)`` after acquire — so live clients can render honest wait UX
    instead of a silent empty 「Thinking…」. Uncontended acquires stay silent.
    """
    lock = _get_lock(key)
    # No yield between locked() check and acquire → no silent-wait race on one loop.
    will_wait = lock.locked()
    waiting_notified = False
    try:
        if will_wait and on_waiting is not None:
            on_waiting(True)
            waiting_notified = True
        await lock.acquire()
        try:
            if waiting_notified and on_waiting is not None:
                on_waiting(False)
                waiting_notified = False
            yield
        finally:
            lock.release()
    finally:
        # Cancelled while blocked on acquire: still clear honest wait UX.
        if waiting_notified and on_waiting is not None:
            on_waiting(False)
