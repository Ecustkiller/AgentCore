"""Over-seat reject latch (MAX_DELEGATION_TASKS batch rejection)."""

from __future__ import annotations

from contextvars import ContextVar

_turn_over_seat_reject: ContextVar[bool] = ContextVar(
    "turn_over_seat_reject", default=False
)


def note_over_seat_reject(*, task_count: int = 0, max_tasks: int = 0) -> None:
    """Latch when builder rejects a batch for exceeding MAX_DELEGATION_TASKS."""
    _ = task_count, max_tasks
    _turn_over_seat_reject.set(True)


def clear_over_seat_reject() -> None:
    _turn_over_seat_reject.set(False)


def turn_has_over_seat_reject() -> bool:
    return bool(_turn_over_seat_reject.get())
