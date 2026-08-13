"""Execution-phase reporting for the git tool (工具执行阶段进度).

Git's engine ceiling reaches ~143s, and most of that wall clock is spent in legs the
user cannot see: queueing behind another index writer, resolving credentials, and the
remote round trip. This module binds the engine-injected ``ToolContext.on_phase`` for
the duration of one ``GitTool.execute`` so those legs can name themselves. The
executor turns each token into the transport-only ``tool_use_progress`` event
(引擎纯化) — never journaled, never folded, so nothing here touches conformance.

A wrong phase is worse than no phase (「卡在凭据查询时绝不能显示正在推送」), so
reporting is arranged to make lying structurally hard:

- Every report fires **at the start of the leg it names**, never ahead of a branch
  that may not be taken. ``_cloud_network_extra_env`` reports credentials only after
  its cloud/user guards, so a local workspace never claims a lookup it skips.
- :data:`PHASE_QUEUED` fires only when the per-repo lock is genuinely held by someone
  else; an uncontended acquire says nothing at all.
- :data:`PHASE_LOCAL` is the default of ``spawn._run_git``, so a git subprocess that
  is not explicitly declared a remote leg reports as local work instead of inheriting
  whatever phase ran before it — a future local step added after a network step
  cannot silently keep showing「Contacting remote」.

Reporting costs one in-memory event per phase CHANGE (repeats are dropped): no
subprocess, no I/O, no effect on the timeout budget.
"""

from __future__ import annotations

import contextlib
import contextvars
from collections.abc import Callable, Iterator

from agentcore.tools.protocol import ToolContext

# Waiting for another index-mutating git call on the same repo (``repo_lock``).
PHASE_QUEUED = "git_queued"
# Account PAT / GitHub token lookup — DB read + decrypt, or the ``gh auth`` probe.
PHASE_CREDENTIALS = "git_credentials"
# Remote round trip: push / pull / fetch's network leg, or create_pr's GitHub REST.
PHASE_REMOTE = "git_remote"
# A local git command is executing (subprocess, or ``git_run`` on the desktop).
# Reuses the shared「Running」token rather than minting a git-only twin.
PHASE_LOCAL = "executing"

GIT_PHASES = frozenset({PHASE_QUEUED, PHASE_CREDENTIALS, PHASE_REMOTE, PHASE_LOCAL})


class _PhaseSink:
    """Per-call phase reporter; collapses repeats so one leg emits one event."""

    __slots__ = ("_emit", "_last")

    def __init__(self, emit: Callable[[str], None]) -> None:
        self._emit = emit
        self._last: str | None = None

    def report(self, phase: str) -> None:
        if phase == self._last:
            return
        self._last = phase
        self._emit(phase)


# Per-call, and per-task by construction: the executor dispatches a round's tool calls
# through ``asyncio.gather``, so each call runs in its own Task with its own contextvar
# copy (the same property ``spawn._git_channel`` already relies on).
_sink: contextvars.ContextVar[_PhaseSink | None] = contextvars.ContextVar(
    "git_ops_phase_sink", default=None
)


@contextlib.contextmanager
def phase_scope(context: ToolContext) -> Iterator[None]:
    """Bind this call's phase sink; a context without one (tests / evals) stays silent."""
    on_phase = context.on_phase
    token = _sink.set(_PhaseSink(on_phase) if on_phase is not None else None)
    try:
        yield
    finally:
        _sink.reset(token)


def report_phase(phase: str) -> None:
    """Name the leg that is starting now (no-op outside :func:`phase_scope`)."""
    sink = _sink.get()
    if sink is not None:
        sink.report(phase)
