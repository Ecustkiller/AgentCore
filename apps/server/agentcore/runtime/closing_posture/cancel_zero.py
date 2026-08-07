"""Cancel / zero-output latch — requires gap checklist, forbids bare re-dispatch."""

from __future__ import annotations

from contextvars import ContextVar

_turn_cancel_zero_output: ContextVar[bool] = ContextVar(
    "turn_cancel_zero_output", default=False
)


def note_cancel_zero_output() -> None:
    """Latch cancel/0-产出：须缺口清单，禁止仅『再派』短句终态."""
    _turn_cancel_zero_output.set(True)


def clear_cancel_zero_output() -> None:
    _turn_cancel_zero_output.set(False)


def turn_has_cancel_zero_output() -> bool:
    return bool(_turn_cancel_zero_output.get())
