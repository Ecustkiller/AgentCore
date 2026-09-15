"""Lifespan salvage for detached chat turns (keep ``runs.py`` under the line ceiling)."""

from __future__ import annotations

import contextlib

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


async def salvage_turns_on_shutdown(*, timeout: float | None = None) -> None:
    """Lifespan shutdown: interrupt live turns, await unwind, force-close leftovers.

    Sets the process-wide shutdown flag first so any racing ``CancelledError``
    (uvicorn teardown) takes the clean-close path instead of orphaning. Timed-out
    runs are force-closed; lease is released only when close succeeds, otherwise
    orphaned so the sweeper can retry (never leave a lease-less RUNNING).
    """
    from agentcore.config import settings
    from agentcore.runtime.leases import orphan_turn_lease, release_turn_lease
    from agentcore.runtime.turn.closer import close_user_stop_turn
    from agentcore.runtime.turn.interrupt import (
        TurnInterruptReason,
        close_turn_interrupted,
    )
    from agentcore.runtime.turn.runs import turn_runs

    grace = float(timeout) if timeout is not None else float(settings.turn_shutdown_grace_seconds)
    turn_runs.begin_shutdown_salvage()
    leftovers = await turn_runs.stop_all_and_drain(timeout=grace)
    if not leftovers:
        return

    for run in leftovers:
        message_id = run.sink.message_id
        if not message_id:
            logger.warning(
                "turn_run.shutdown_force_release",
                conversation_id=run.conversation_id,
                run_id=run.run_id,
                released=False,
                reason="missing_message_id",
            )
            continue
        closed = False
        with contextlib.suppress(Exception):
            closed = await close_user_stop_turn(
                sink=run.sink,
                conversation_id=run.conversation_id,
                trace_id="",
                message_id=message_id,
            )
        if not closed:
            with contextlib.suppress(Exception):
                closed = await close_turn_interrupted(
                    message_id=message_id,
                    conversation_id=run.conversation_id,
                    reason=TurnInterruptReason.USER_STOP,
                    load_stream_state=True,
                )
        if closed:
            await release_turn_lease(message_id)
        else:
            with contextlib.suppress(Exception):
                await orphan_turn_lease(message_id)
        logger.info(
            "turn_run.shutdown_force_release",
            conversation_id=run.conversation_id,
            run_id=run.run_id,
            message_id=message_id,
            closed=closed,
            released=bool(closed),
        )
