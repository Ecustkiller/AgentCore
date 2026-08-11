"""Force a quiet user-visible sentence when local exec env is sticky-dead.

Mirrors ``channel_dead_notice``: model steers alone leave users without
「本机暂时跑不了命令」. Stamp the live coordination session and emit one
``content_delta`` when a host sink is still open.
"""

from __future__ import annotations

import contextlib

from agentcore.core.logging import get_logger
from agentcore.workspace.limits import EXEC_ENV_DEAD_USER_VISIBLE

logger = get_logger(__name__)


def mark_and_emit_exec_env_dead_user_notice(*, execution_id: str | None = None) -> None:
    """Stamp session + one-shot host ``content_delta`` (never raises)."""
    try:
        from agentcore.runtime.coordination.session import active_coordination
        from agentcore.runtime.events import content_delta

        session = active_coordination(execution_id)
        if session is None:
            return
        session.exec_env_dead = True
        if session.exec_env_dead_user_notice_emitted:
            return
        session.exec_env_dead_user_notice_emitted = True
        sink = session.event_sink
        if sink is None or getattr(sink, "_closed", False):
            return
        with contextlib.suppress(Exception):
            sink.emit(content_delta(EXEC_ENV_DEAD_USER_VISIBLE + "\n\n"))
        logger.info(
            "coordination.exec_env_dead_user_notice",
            execution_id=session.execution_id,
        )
    except Exception:  # noqa: BLE001 — notice must never break the tool path
        logger.warning(
            "coordination.exec_env_dead_user_notice_failed",
            execution_id=execution_id,
            exc_info=True,
        )
