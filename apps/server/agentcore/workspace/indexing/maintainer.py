"""Background code-index maintenance — never on the ``code_search`` critical path."""

from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.workspace.channel import index_io_mode

if TYPE_CHECKING:
    from agentcore.workspace.indexing.manager import IndexManager
    from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Wait for Local tool-channel quiet before index IO; skip+reschedule if still busy.
_CHANNEL_QUIET_POLL_S = 0.05
_CHANNEL_QUIET_WAIT_MAX_S = 2.0


def _optional_build_fields(manager: Any) -> dict[str, Any]:
    """Pick up short build context when manager exposes public read-only attrs.

    Core bucket may add ``generation`` / truncated / file-count accessors later;
    omit quietly when absent — do not reach into private status fields.
    """
    out: dict[str, Any] = {}
    for key, names in (
        ("generation", ("generation", "index_generation")),
        ("truncated", ("index_truncated", "truncated")),
        ("files", ("indexed_file_count", "file_count", "files")),
    ):
        for name in names:
            if not hasattr(manager, name):
                continue
            val = getattr(manager, name)
            if callable(val):
                try:
                    val = val()
                except Exception:
                    continue
            if val is not None:
                out[key] = val
                break
    return out


class IndexMaintainer:
    """Coalesced background ``ensure_index`` for one workspace backend.

    ``code_search`` only queries; this owner builds/refreshes. Concurrent
    ``schedule`` calls coalesce into one run (+ one follow-up if dirty again).
    """

    def __init__(self, manager: IndexManager, backend: WorkspaceBackend) -> None:
        self._manager = manager
        self._backend = backend
        self._task: asyncio.Task[None] | None = None
        self._force = False
        self._rerun = False
        self._lock = asyncio.Lock()

    @property
    def building(self) -> bool:
        return self._task is not None and not self._task.done()

    def schedule(self, *, force: bool = False) -> None:
        """Fire-and-forget ensure; safe to call from sync mutation paths."""
        if force:
            self._force = True
        if self.building:
            self._rerun = True
            self._manager.set_building(True)
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._manager.set_building(True)
        self._task = loop.create_task(self._run(), name="code-index-maintain")

    async def drain(self) -> None:
        """Await until maintenance (including coalesced follow-ups) has settled."""
        while True:
            task = self._task
            if task is not None and not task.done():
                try:
                    await task
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # ``_run`` already logs; drain must still clear the chain.
                    pass
                continue
            # ``_run`` finally may clear ``_task`` then ``schedule()`` a follow-up;
            # yield so that create_task is visible before we decide idle.
            await asyncio.sleep(0)
            if self._task is not None and not self._task.done():
                continue
            if self._rerun:
                self.schedule()
                continue
            return

    async def _wait_channel_quiet(self, channel: Any) -> bool:
        """Return True when ``channel._inflight`` is empty; False if still busy at cap."""
        inflight = getattr(channel, "_inflight", None)
        if inflight is None:
            return True
        deadline = asyncio.get_running_loop().time() + _CHANNEL_QUIET_WAIT_MAX_S
        while inflight:
            if asyncio.get_running_loop().time() >= deadline:
                return False
            await asyncio.sleep(_CHANNEL_QUIET_POLL_S)
        return True

    async def _run(self) -> None:
        async with self._lock:
            force = False
            started = time.perf_counter()
            try:
                channel = getattr(self._backend, "_channel", None)
                if (
                    channel is not None
                    and getattr(channel, "_inflight", None) is not None
                    and not await self._wait_channel_quiet(channel)
                ):
                    # Tool hot path still using the shared Local channel — skip
                    # this round and coalesce a follow-up instead of hard-charging.
                    inflight = getattr(channel, "_inflight", None) or ()
                    logger.info(
                        "workspace.index_skip_channel_busy",
                        force=self._force,
                        wait_ms=int(_CHANNEL_QUIET_WAIT_MAX_S * 1000),
                        inflight=len(inflight),
                    )
                    self._rerun = True
                    return
                force = self._force
                self._force = False
                logger.info("workspace.index_build_start", force=force)
                started = time.perf_counter()
                with index_io_mode():
                    updated = await self._manager.ensure_index(self._backend, force=force)
                duration_ms = int((time.perf_counter() - started) * 1000)
                logger.info(
                    "workspace.index_build_complete",
                    force=force,
                    updated=bool(updated),
                    duration_ms=duration_ms,
                    **_optional_build_fields(self._manager),
                )
            except Exception as exc:
                duration_ms = int((time.perf_counter() - started) * 1000)
                logger.exception(
                    "workspace.index_failed",
                    force=force,
                    duration_ms=duration_ms,
                    error=type(exc).__name__,
                )
            finally:
                self._manager.set_building(False)
                if self._rerun:
                    self._rerun = False
                    # Current task is still "not done" until we exit finally —
                    # clear so schedule() can spawn the follow-up instead of
                    # only arming _rerun into a void.
                    self._task = None
                    self.schedule()
