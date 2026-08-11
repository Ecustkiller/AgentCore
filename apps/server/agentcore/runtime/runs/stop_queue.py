"""Turn-scoped queue for user-initiated per-worker stop (只停这项工作).

While ``delegate`` is driving, the CEO coroutine is blocked — user mid-flight stop
must arrive on a separate channel (same posture as
:mod:`agentcore.runtime.runs.redirect_queue`). This module holds pending
``(execution_id, run_id|None)`` requests until ``RedirectController.cancel_run_ids``
drains them into the WaveScheduler cancel set.

Semantics (≠ redirect):
- cancel in-flight targets → ``run_cancelled(reason=user_stop)``
- withdraw not-yet-dispatched targets → ``run_skipped(reason=abort)``
- **no** hot revision / cold ``_redir`` follow-up
- does not abort the turn, kill the CEO, or clear FIFO queued turns

``run_id is None`` means stop **all** in-flight + queued workers for that execution
(expanded against the live plan when drained).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RunStopRequest:
    execution_id: str
    """Target run, or ``None`` / empty to stop every worker in the execution."""

    run_id: str | None
    conversation_id: str


_pending: dict[str, list[RunStopRequest]] = {}


def enqueue_stop(
    *,
    execution_id: str,
    conversation_id: str,
    run_id: str | None = None,
) -> RunStopRequest:
    """Queue a user stop for the given batch execution. Returns the enqueued item."""
    rid = (run_id or "").strip() or None
    item = RunStopRequest(
        execution_id=execution_id.strip(),
        run_id=rid,
        conversation_id=conversation_id.strip(),
    )
    bucket = _pending.setdefault(item.execution_id, [])
    bucket.append(item)
    return item


def take_stops(execution_id: str) -> list[RunStopRequest]:
    """Drain and return all pending stops for ``execution_id`` (FIFO)."""
    return _pending.pop(execution_id.strip(), [])


def peek_stop_count(execution_id: str) -> int:
    """How many stops are queued for ``execution_id`` (does not drain)."""
    return len(_pending.get(execution_id.strip(), []))
