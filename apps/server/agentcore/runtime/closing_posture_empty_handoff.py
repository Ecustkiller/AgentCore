"""Empty/degraded handoff storm latch (delivery_status → PARTIAL)."""

from __future__ import annotations

from contextvars import ContextVar

_turn_empty_handoff_storm: ContextVar[bool] = ContextVar(
    "turn_empty_handoff_storm", default=False
)


def note_empty_handoff_storm() -> None:
    """Latch when delivery_status sees many empty/degraded handoffs → PARTIAL."""
    _turn_empty_handoff_storm.set(True)


def clear_empty_handoff_storm() -> None:
    _turn_empty_handoff_storm.set(False)


def turn_has_empty_handoff_storm() -> bool:
    return bool(_turn_empty_handoff_storm.get())
