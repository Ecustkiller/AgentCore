"""Per-repository serialization for index-mutating git calls.

One ReAct round dispatches its tool calls in parallel (``MAX_PARALLEL_TOOLS``), so
the model routinely lands two git calls on the same repo at once. Commands that
take ``.git/index.lock`` cannot overlap: git refuses or stalls the second one and
the failure reads like a repo fault instead of the self-inflicted race it is. This
module queues those calls per repo so at most one index writer runs at a time.

Scope is deliberately narrow (see ``policy._INDEX_LOCK_SUBCOMMANDS``):

- **Reads never queue.** ``GIT_OPTIONAL_LOCKS=0`` — set by both the server spawn
  env and desktop ``gitRun`` — stops read-only git from refreshing the index, so a
  read never touches ``index.lock`` and cannot collide with a writer. Queueing
  reads would cost the common parallel ``status`` + ``diff`` pattern its
  concurrency and buy nothing.
- **Writes that miss the index never queue** either — ``push`` / ``create_pr``
  (network plus refs / REST) and ``branch`` / ``tag`` / ``remote`` (their own ref /
  config locks, uncontended among allowlisted verbs).

Waiting is bounded by ``_GIT_REPO_LOCK_WAIT`` and that same budget is charged to
``git_tool_timeout_seconds`` for exactly the calls that queue, so queue time can
never push the caller past the engine's outer ``wait_for``. Exhausting the wait
returns an honest ``repo_busy`` — the command never ran and the repo is untouched.
No retry happens here; the model decides.

Single process, single machine. Two API workers on one shared volume still fall
back to git's own ``index.lock``, which fails honestly: this removes the
self-inflicted collisions, it does not promise distributed mutual exclusion. The
loop-keyed registry mirrors ``workspace.locks`` (a different key space — the
folder write lock must not be entangled with a minute-long ``pull``).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import weakref
from collections.abc import AsyncIterator
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.tools.protocol import ToolContext, ToolResult

from .phases import PHASE_QUEUED, report_phase
from .policy import _GIT_REPO_LOCK_WAIT, _REPO_BUSY_CODE, git_call_needs_repo_lock
from .results import _error

logger = get_logger(__name__)

# loop -> {repo_key: Lock}. WeakKeyDictionary so a finished loop's locks are
# collected with it (pytest builds one loop per test); production has one loop and
# therefore one registry.
_registries: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, dict[str, asyncio.Lock]] = (
    weakref.WeakKeyDictionary()
)

_REPO_BUSY_MESSAGE = (
    "同一仓库上已有另一个 Git 写操作在执行，等待 {waited:.0f} 秒后仍未空闲。"
    "本次命令未执行，仓库状态未改变（不是 Git 故障，也不是仓库损坏）。"
    "请等上一个写操作结束后再发起，并避免同一轮并行发多个写命令。"
)


def repo_lock_key(cwd: str, context: ToolContext) -> str:
    """Identity of the ``.git`` this call will touch — one lock per real repo.

    Subprocess path: the resolved workspace root, case-folded so Windows cannot
    hand out two locks for one directory. Channel path (``cwd == ""``): the desktop
    root grant plus project subpath, matching what ``spawn`` actually sends over
    ``git_run``. Two users' identically named projects stay independent; two
    conversations bound to the *same* checkout share one queue, which is correct —
    they share one ``index.lock`` on that machine.
    """
    if cwd:
        return f"path:{os.path.normcase(cwd)}"
    channel = context.workspace_channel
    user_id = getattr(channel, "user_id", "") or ""
    root_id = getattr(channel, "root_id", "") or ""
    base = getattr(context.backend, "base_subpath", "") or ""
    sub = str(base).strip().strip("/").replace("\\", "/")
    return f"desktop:{user_id}:{root_id}:{'' if sub == '.' else sub}"


def _get_repo_lock(key: str) -> asyncio.Lock:
    """Process-wide lock for ``key`` on the running loop (created once).

    Synchronous and free of ``await``, so get-or-create is atomic on the
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


async def _acquire_repo_lock(lock: asyncio.Lock, *, timeout: float = _GIT_REPO_LOCK_WAIT) -> bool:
    """Bounded acquire; ``False`` = the repo is still busy after ``timeout``.

    ``asyncio.Lock.acquire`` hands the lock to the next waiter when a granted
    waiter is cancelled, so a timed-out wait cannot strand the lock.
    """
    try:
        await asyncio.wait_for(lock.acquire(), timeout)
    except TimeoutError:
        return False
    return True


@contextlib.asynccontextmanager
async def repo_write_lock(
    arguments: dict[str, Any],
    *,
    cwd: str,
    context: ToolContext,
    start: float,
    meta: dict[str, Any],
) -> AsyncIterator[ToolResult | None]:
    """Serialize index-mutating git per repo; yield ``None`` when clear to run.

    Yields a ``repo_busy`` ToolResult instead when the bounded wait expires — the
    caller returns it unchanged. Reads and non-index writes yield ``None``
    immediately without touching the registry, so they keep full parallelism.
    """
    if not git_call_needs_repo_lock(arguments):
        yield None
        return

    lock = _get_repo_lock(repo_lock_key(cwd, context))
    # Only a lock someone else holds makes this call wait, and only then may the UI
    # say so — an uncontended acquire never suspends, so claiming「排队中」there would
    # be a phase the user's git call never actually spent time in.
    if lock.locked():
        report_phase(PHASE_QUEUED)
    if await _acquire_repo_lock(lock):
        try:
            yield None
        finally:
            lock.release()
        return

    subcommand = str(arguments.get("subcommand", "")).strip().lower()
    logger.warning(
        "git.repo_busy",
        subcommand=subcommand,
        wait_seconds=_GIT_REPO_LOCK_WAIT,
    )
    yield _error(
        _REPO_BUSY_MESSAGE.format(waited=_GIT_REPO_LOCK_WAIT),
        start,
        metadata={**meta, "code": _REPO_BUSY_CODE},
    )
