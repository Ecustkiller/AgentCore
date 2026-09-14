"""Host hook: close a user-stopped turn (shutdown salvage).

``conversation.service`` binds
``conversation.turn_persistence.close_user_stop_turn``. Runtime never imports
that module. Unbound (tests / miswired boot) returns False so
``salvage_turns_on_shutdown`` falls through to ``close_turn_interrupted``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agentcore.runtime.events import EventSink

_user_stop_closer: Any = None


def set_user_stop_closer(closer: Any) -> None:
    """Install the host close-user-stop implementation (once per process)."""
    global _user_stop_closer
    _user_stop_closer = closer


def reset_user_stop_closer_for_tests() -> None:
    """Tests: drop the bound closer so salvage falls through to interrupt close."""
    global _user_stop_closer
    _user_stop_closer = None


async def close_user_stop_turn(
    *,
    sink: EventSink,
    conversation_id: str,
    trace_id: str,
    message_id: str | None = None,
    journal_entries: list[dict[str, Any]] | None = None,
) -> bool:
    """Delegate to the bound host closer, or False when unwired."""
    if _user_stop_closer is None:
        return False
    return await _user_stop_closer(
        sink=sink,
        conversation_id=conversation_id,
        trace_id=trace_id,
        message_id=message_id,
        journal_entries=journal_entries,
    )
