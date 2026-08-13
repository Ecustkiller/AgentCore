"""Cancel-safe turn teardown: a re-delivered cancel must not skip the ``finally``."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from typing import Any

from agentcore.core.logging import get_logger

logger = get_logger(__name__)


async def teardown_step(awaitable: Awaitable[Any], *, step: str) -> None:
    """Await one turn-teardown step that a second cancel must not be able to skip.

    ``contextlib.suppress(Exception)`` cannot hold a turn's ``finally`` together:
    ``CancelledError`` is a ``BaseException``, so「Stop 点两下」/「Stop 后立刻发新
    消息」(overlap supersede) pierces the first ``await`` in the block and every
    later step is dropped — journal flush, audit flush, ``release_turn_coordination``,
    ``llm.close()`` — leaking the httpx client and losing the journal tail.

    The step runs shielded and is re-awaited until it settles, absorbing the extra
    cancel. The run still ends cancelled: the original ``CancelledError`` keeps
    propagating out of the ``finally`` once teardown is done. Same posture as the
    wave scheduler's ``shield(gather(...))`` unwind.
    """
    try:
        task = asyncio.ensure_future(awaitable)
    except Exception as e:  # noqa: BLE001 — one broken step must not skip the rest
        logger.warning("turn_teardown.step_failed", step=step, error=str(e))
        return
    while True:
        try:
            await asyncio.shield(task)
            return
        except asyncio.CancelledError:
            if task.done():
                _log_step_error(task, step=step)
                return
            logger.info("turn_teardown.cancel_absorbed", step=step)
        except Exception as e:  # noqa: BLE001 — teardown is best-effort per step
            logger.warning("turn_teardown.step_failed", step=step, error=str(e))
            return


def _log_step_error(task: asyncio.Task[Any], *, step: str) -> None:
    """Retrieve a settled step's failure so it is never an unobserved exception."""
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.warning("turn_teardown.step_failed", step=step, error=str(error))
