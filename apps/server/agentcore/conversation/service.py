"""Conversation service facade — re-exports the split turn modules.

Import from here to keep route and test import paths stable:
``from agentcore.conversation.service import stream_chat``, etc.
"""

from typing import Any

from agentcore.conversation.handoff_jobs import dispatch_handoff, run_handoff_job
from agentcore.conversation.local_turn import (
    abort_local_turn,
    append_local_turn_journal,
    begin_local_turn,
    heartbeat_local_turn,
    record_local_turn,
    upsert_local_turn_stream_segments,
)
from agentcore.conversation.turns import (
    continue_chat,
    regenerate_chat,
    resume_chat,
    stream_chat,
)

__all__ = [
    "abort_local_turn",
    "append_local_turn_journal",
    "begin_local_turn",
    "continue_chat",
    "dispatch_handoff",
    "heartbeat_local_turn",
    "record_local_turn",
    "regenerate_chat",
    "resume_chat",
    "run_handoff_job",
    "stream_chat",
    "upsert_local_turn_stream_segments",
]


class _ServiceTurnDriver:
    """conversation.service implements runtime ``TurnDriver`` (start / resume)."""

    async def start_turn(self, **kwargs: Any) -> None:
        await stream_chat(**kwargs)

    async def resume_turn(self, **kwargs: Any) -> None:
        await resume_chat(**kwargs)


def _bind_runtime_turn_driver() -> None:
    from agentcore.runtime.turn.driver import bind_turn_driver

    bind_turn_driver(_ServiceTurnDriver())


def _bind_runtime_conversation_store() -> None:
    from agentcore.runtime.conversation_store import set_conversation_store_factory

    def _cloud_store():
        from agentcore.conversation.store.cloud import get_cloud_store

        return get_cloud_store()

    set_conversation_store_factory(_cloud_store)


def _bind_runtime_user_stop_closer() -> None:
    from agentcore.conversation.turn_persistence import close_user_stop_turn
    from agentcore.runtime.turn.closer import set_user_stop_closer

    set_user_stop_closer(close_user_stop_turn)


_bind_runtime_turn_driver()
_bind_runtime_conversation_store()
_bind_runtime_user_stop_closer()
