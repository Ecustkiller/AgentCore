"""Run the chat pipeline and persist the turn (shared by send / regenerate / resume)."""

import asyncio
import time

from agentcore.config import settings
from agentcore.conversation.common import preview
from agentcore.conversation.turn_persistence import persist_turn_result, salvage_incomplete_turn
from agentcore.core.log_context import log_context, new_trace_id
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.modes import ProfileSet
from agentcore.runtime.events import EventSink
from agentcore.runtime.pipeline import run_chat_pipeline
from agentcore.runtime.session_persistence import load_run_session, save_run_session
from agentcore.runtime.suspension_persistence import delete_paused_turn, save_paused_turn
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


def session_callbacks(conversation_id: str):
    """The 留人 跨进程落盘 write-through saver + roster-miss loader, or ``(None, None)``."""
    if not settings.session_roster_persist_enabled:
        return None, None

    async def _persist_session(session) -> None:
        await save_run_session(conversation_id, session)

    return _persist_session, load_run_session


def suspension_callbacks():
    """The 结构化挂起 2b persist-before-wait / drop-after-resolve closures."""
    if not settings.structured_suspension_persist_enabled:
        return None, None
    return save_paused_turn, delete_paused_turn


async def run_and_persist(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    folder_id: str | None,
    sink: EventSink,
    history: list[dict],
    attachments: list[dict] | None,
    backend: WorkspaceBackend,
    generate_title: bool,
    llm_credentials: LLMCredentials | None,
    profile_set: ProfileSet | None = None,
    memory_enabled: bool = True,
    board_id: str | None = None,
) -> None:
    """Run the pipeline, persist the assistant reply, then title + memory."""
    session_saver, session_loader = session_callbacks(conversation_id)
    suspension_saver, suspension_deleter = suspension_callbacks()

    turn_id = new_id()
    trace_id = new_trace_id()
    started = time.monotonic()
    with log_context(
        trace_id=trace_id,
        conversation_id=conversation_id,
        user_id=user_id,
        turn_id=turn_id,
        agent_id="CEO",
    ):
        logger.info(
            "chat.turn_start",
            chars=len(user_message or ""),
            preview=preview(user_message),
            history=len(history),
            attachments=len(attachments or []),
            location=backend.location,
        )
        try:
            result = await run_chat_pipeline(
                conversation_id=conversation_id,
                user_message=user_message,
                history=history,
                sink=sink,
                user_id=user_id,
                backend=backend,
                folder_id=folder_id,
                board_id=board_id,
                attachments=attachments,
                llm_credentials=llm_credentials,
                memory_enabled=memory_enabled,
                profile_set=profile_set,
                session_saver=session_saver,
                session_loader=session_loader,
                suspension_saver=suspension_saver,
                suspension_deleter=suspension_deleter,
            )
        except asyncio.CancelledError:
            salvage_incomplete_turn(sink=sink, conversation_id=conversation_id, trace_id=trace_id)
            raise
        finish = result.get("finish_reason")
        cost_runs = result.get("cost_runs") or []
        duration_ms = int((time.monotonic() - started) * 1000)
        workers = max(len(cost_runs) - 1, 0)
        logger.info(
            "chat.turn_complete",
            finish_reason=getattr(finish, "value", finish),
            rounds=result.get("rounds", 0),
            input_tokens=result.get("input_tokens", 0),
            output_tokens=result.get("output_tokens", 0),
            reasoning_tokens=result.get("reasoning_tokens", 0),
            reply_chars=len(result.get("content") or ""),
            delegated=workers > 0,
            workers=workers,
            duration_ms=duration_ms,
            error=result.get("error"),
        )

    await persist_turn_result(
        result=result,
        conversation_id=conversation_id,
        user_id=user_id,
        folder_id=folder_id,
        backend=backend,
        sink=sink,
        user_message=user_message,
        generate_title=generate_title,
        llm_credentials=llm_credentials,
        trace_id=trace_id,
        turn_id=turn_id,
        duration_ms=duration_ms,
        kind="turn",
    )
