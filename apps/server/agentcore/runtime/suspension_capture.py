"""Shared capture skeleton for durable suspension frames.

The three suspending faces (ask_user / plan_review / team_preview) share one capture
shape: read the CEO transcript, fold the about-to-emit ``*_required`` into the fact-log
snapshot (the §8.3 唯一权威载体), then hand the pieces to a kind-specific frame builder +
saver. The display ``journal`` (resume seed) is NOT captured here — it is a DERIVED
property of ``journal_entries`` (P0-B Phase 3), so there is no second, drift-prone copy.
Kind-specific fields and the frame subclass stay at the call site — this module only
owns the common skeleton so the three faces cannot drift.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.suspension import TurnSuspension

logger = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class SuspensionCapture:
    """Shared capture payload handed to a kind-specific frame builder."""

    transcript: list[Any]
    history: list[dict[str, Any]]
    journal_entries: list[dict[str, Any]]
    trace_id: str | None


async def persist_suspension_capture(
    *,
    checkpoint_id: str,
    required_event: Any,
    build_frame: Callable[[SuspensionCapture], TurnSuspension],
    saver: Callable[[TurnSuspension], Awaitable[None]],
) -> bool:
    """Capture transcript + the fact-log snapshot, build the kind frame, and save.

    Returns ``True`` iff a durable frame was actually saved. Skips (returns ``False``)
    when the CEO transcript is absent — a faithful resume is impossible without it.
    Best-effort: the saver swallows its own errors.
    """
    from agentcore.core.log_context import get_log_value
    from agentcore.runtime.facts import snapshot_fact_log
    from agentcore.runtime.suspension import captain_transcript, turn_history

    transcript = captain_transcript.get()
    if not transcript:
        logger.info("suspension.no_transcript", checkpoint_id=checkpoint_id)
        return False

    journal_entries = snapshot_fact_log(
        trailing=[
            {
                "kind": required_event.type.value,
                "payload": required_event.payload,
                "ts": required_event.timestamp,
            }
        ]
    )
    capture = SuspensionCapture(
        transcript=list(transcript),
        history=list(turn_history.get() or []),
        journal_entries=journal_entries,
        trace_id=get_log_value("trace_id"),
    )
    frame = build_frame(capture)
    await saver(frame)
    return True
