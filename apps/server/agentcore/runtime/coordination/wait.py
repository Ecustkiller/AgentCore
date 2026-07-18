"""Between-round coordination wait for the CEO ReAct loop (Phase 2)."""

from __future__ import annotations

import time

from agentcore.core.logging import get_logger
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.runtime.coordination.inject import events_to_messages
from agentcore.runtime.coordination.journal import record_coordination_snapshot
from agentcore.runtime.coordination.session import (
    CoordinationEvent,
    CoordinationEventKind,
    CoordinationSession,
    active_coordination,
)

logger = get_logger(__name__)

# How long to wait for the next team event when the CEO has nothing else to do.
_COORD_WAIT_TIMEOUT_S = 120.0


def _drive_exhausted(session: CoordinationSession) -> bool:
    """True when the background drive cannot produce further team events."""
    if session.total_workers <= 0:
        return False
    if len(session.completed_run_ids) < session.total_workers:
        return False
    task = session.drive_task
    return task is None or task.done()


def _synthetic_all_completed(session: CoordinationSession) -> CoordinationEvent:
    return CoordinationEvent(
        kind=CoordinationEventKind.ALL_COMPLETED,
        payload={
            "completed": len(session.completed_run_ids),
            "total": session.total_workers,
            "reason": "team_done_shortcircuit",
        },
    )


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

    t0 = time.perf_counter()
    events = session.drain_nowait()
    wait_reason = "drained"
    if not events and _drive_exhausted(session):
        # Invariant guard: drive+host should have left ALL_COMPLETED in the queue.
        # Firing here means a new leak — keep CEO moving, but warn loudly.
        wait_reason = "team_done_shortcircuit"
        events = [_synthetic_all_completed(session)]
        logger.warning(
            "coordination.team_done_shortcircuit",
            execution_id=session.execution_id,
            completed=len(session.completed_run_ids),
            total=session.total_workers,
            detail=(
                "不变量护栏触发：全员已完成且 drive 已结束，队列仍无终态事件。"
                "本不应发生——说明有新路径漏投 ALL_COMPLETED，请追查 drive/host。"
            ),
        )
    elif not events:
        events = await session.wait_events(timeout=_COORD_WAIT_TIMEOUT_S)
        wait_reason = "waited" if events else "idle_timeout"
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

    waited_ms = int((time.perf_counter() - t0) * 1000)
    event_kinds = [e.kind.value for e in events]
    logger.info(
        "coordination.wait_end",
        execution_id=session.execution_id,
        waited_ms=waited_ms,
        wait_reason=wait_reason,
        events=event_kinds,
        completed=len(session.completed_run_ids),
        total=session.total_workers,
        budget=session.budget_remaining,
    )

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
        events=event_kinds,
        budget=session.budget_remaining,
    )
    return injected
