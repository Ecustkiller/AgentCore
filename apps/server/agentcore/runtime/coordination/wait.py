"""Between-round coordination wait for the CEO ReAct loop (Phase 2)."""

from __future__ import annotations

from agentcore.core.logging import get_logger
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.coordination.inject import events_to_messages
from agentcore.runtime.coordination.journal import record_coordination_snapshot
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    active_coordination,
)

logger = get_logger(__name__)

# How long to wait for the next team event when the CEO has nothing else to do.
_COORD_WAIT_TIMEOUT_S = 120.0


async def await_coordination_injection(
    messages: list[LLMMessage],
) -> list[LLMMessage]:
    """If a coordination session is active, wait for team events and inject them.

    Called at the top of each ReAct round after the first. Returns messages to
    append (possibly empty when not coordinating). Mid-wave noise under a spent
    budget still injects a template brief; necessary decision points always wake.
    """
    session = active_coordination()
    if session is None or not session.active:
        return []

    events = session.drain_nowait()
    if not events:
        events = await session.wait_events(timeout=_COORD_WAIT_TIMEOUT_S)
    if not events:
        # Still coordinating but nothing arrived — nudge rather than a blind LLM round.
        # Idle wait nudge (no per-worker timer fired) — distinct from worker TIMEOUT.
        events = [
            CoordinationEvent(
                kind=CoordinationEventKind.TIMEOUT,
                payload={
                    "run_id": "",
                    "role": "team",
                    "status": "idle_wait",
                    "reason": (
                        f"等待团队事件超时（已完成 {len(session.completed_run_ids)}/"
                        f"{session.total_workers}）。可继续等、update_synthesis、"
                        "cancel_worker，或 ask_user。"
                    ),
                },
            )
        ]

    necessary = session.is_necessary_decision(events)
    has_all = any(e.kind is CoordinationEventKind.ALL_COMPLETED for e in events)

    if not necessary and session.budget_remaining <= 0:
        logger.info(
            "coordination.budget_skip_llm",
            execution_id=session.execution_id,
            events=len(events),
        )
    elif necessary or session.consume_budget():
        session.note_decision_points(events)
    else:
        logger.info(
            "coordination.budget_exhausted",
            execution_id=session.execution_id,
            events=len(events),
        )

    if has_all:
        session.all_completed_injected = True
        session.close()
        logger.info(
            "coordination.all_completed",
            execution_id=session.execution_id,
            completed=len(session.completed_run_ids),
            total=session.total_workers,
        )

    record_coordination_snapshot(session)
    injected = events_to_messages(session, events)
    logger.debug(
        "coordination.injected",
        execution_id=session.execution_id,
        events=[e.kind.value for e in events],
        budget=session.budget_remaining,
    )
    return injected
