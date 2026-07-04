"""Turn-scoped queue for user-initiated worker redirects (中间可见性 Phase 2a).

While ``delegate`` is driving, the CEO coroutine is blocked — user mid-flight steer
must arrive on a separate channel. This module holds pending ``(execution_id, run_id,
feedback)`` requests until the WaveScheduler / drive loop drains them (Step 2:
cancel + cold re-run). Step 1: enqueue + log only.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RunRedirectRequest:
    execution_id: str
    run_id: str
    feedback: str
    conversation_id: str


_pending: dict[str, list[RunRedirectRequest]] = {}


def enqueue_redirect(
    *,
    execution_id: str,
    run_id: str,
    feedback: str,
    conversation_id: str,
) -> RunRedirectRequest:
    """Queue a user redirect for the given batch execution. Returns the enqueued item."""
    item = RunRedirectRequest(
        execution_id=execution_id.strip(),
        run_id=run_id.strip(),
        feedback=feedback.strip(),
        conversation_id=conversation_id.strip(),
    )
    bucket = _pending.setdefault(item.execution_id, [])
    bucket.append(item)
    return item


def take_redirects(execution_id: str) -> list[RunRedirectRequest]:
    """Drain and return all pending redirects for ``execution_id`` (FIFO)."""
    return _pending.pop(execution_id, [])


def peek_redirect_count(execution_id: str) -> int:
    """Pending redirect count (tests / diagnostics)."""
    return len(_pending.get(execution_id, []))
