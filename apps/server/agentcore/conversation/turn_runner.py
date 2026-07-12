"""Run the chat pipeline and persist the turn (shared by send / regenerate / resume)."""

import asyncio
import contextlib
import time

from agentcore.config import settings
from agentcore.conversation.common import preview
from agentcore.conversation.turn_persistence import (
    create_assistant_placeholder,
    persist_turn_result,
    salvage_incomplete_turn,
)
from agentcore.core.log_context import log_context, new_trace_id
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.llm.profiles import TurnProfiles as ProfileSet
from agentcore.llm.resolve import LLMCredentials
from agentcore.runtime.events import EventSink
from agentcore.runtime.leases import (
    acquire_turn_lease,
    lease_heartbeat_loop,
    release_turn_lease,
)
from agentcore.runtime.pipeline import run_chat_pipeline
from agentcore.runtime.session_persistence import load_run_session, save_run_session
from agentcore.runtime.suspension_persistence import delete_paused_turn, save_paused_turn
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)


def session_callbacks(conversation_id: str):
    """The 留人 跨进程落盘 write-through saver + roster-miss loader, or ``(None, None)``.

    The raw saver awaits DB I/O; ``run_chat_pipeline`` / ``resume_chat_pipeline`` wrap
    it in :class:`~agentcore.runtime.session_persistence.SessionRosterWriter` so the
    hot path only schedules, and turn-end flush drains pending writes (as-built: 成本配额 §三).
    """
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
    autonomy_policy=None,
    board_id: str | None = None,
    llm_supports_tools: bool | None = None,
    x_client_platform: str | None = None,
) -> None:
    """Run the pipeline, persist the assistant reply, then title + memory.
    """
    session_saver, session_loader = session_callbacks(conversation_id)
    suspension_saver, suspension_deleter = suspension_callbacks()

    message_id = new_id()
    turn_id = new_id()
    trace_id = new_trace_id()
    started = time.monotonic()
    lease_stop: asyncio.Event | None = None
    heartbeat_task: asyncio.Task | None = None
    with log_context(
        trace_id=trace_id,
        conversation_id=conversation_id,
        user_id=user_id,
        turn_id=turn_id,
        message_id=message_id,
        agent_id="CEO",
        cost_role="captain",
        persona="CEO",
    ):
        logger.info(
            "chat.turn_start",
            chars=len(user_message or ""),
            preview=preview(user_message),
            history=len(history),
            attachments=len(attachments or []),
            location=backend.location,
            message_id=message_id,
        )
        await create_assistant_placeholder(
            conversation_id=conversation_id,
            message_id=message_id,
            trace_id=trace_id,
        )
        sink.bind_content_checkpoint(
            conversation_id=conversation_id,
            message_id=message_id,
        )
        if settings.turn_lease_enabled:
            owner_id = await acquire_turn_lease(
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                phase="running",
                meta={"trace_id": trace_id, "folder_id": folder_id},
            )
            lease_stop = asyncio.Event()
            heartbeat_task = asyncio.create_task(
                lease_heartbeat_loop(
                    message_id,
                    owner_id=owner_id,
                    interval_seconds=settings.turn_lease_heartbeat_seconds,
                    stop=lease_stop,
                )
            )
        try:
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
                    autonomy_policy=autonomy_policy,
                    profile_set=profile_set,
                    session_saver=session_saver,
                    session_loader=session_loader,
                    suspension_saver=suspension_saver,
                    suspension_deleter=suspension_deleter,
                    llm_supports_tools=llm_supports_tools,
                    message_id=message_id,
                    x_client_platform=x_client_platform,
                )
            except asyncio.CancelledError:
                salvage_incomplete_turn(
                    sink=sink,
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                    message_id=message_id,
                )
                raise
            finish = result.get("finish_reason")
            cost_runs = result.get("cost_runs") or []
            duration_ms = int((time.monotonic() - started) * 1000)
            workers = max(len(cost_runs) - 1, 0)
            collab = result.get("collab") or {}
            logger.info(
                "chat.turn_complete",
                finish_reason=getattr(finish, "value", finish),
                rounds=result.get("rounds", 0),
                input_tokens=result.get("input_tokens", 0),
                output_tokens=result.get("output_tokens", 0),
                reasoning_tokens=result.get("reasoning_tokens", 0),
                reply_chars=len(result.get("content") or ""),
                reply_preview=preview(result.get("content") or ""),
                delegated=workers > 0,
                workers=workers,
                # 协作质量 (学·度量 §2.5): per-turn orchestration signals, also persisted to
                # turn_metrics for the operator面 (offline log_stats derives same from raw events).
                boundary_yields=collab.get("boundary_yields", 0),
                scope_signals=collab.get("scope_signals", 0),
                escalations=collab.get("escalations", 0),
                revises=collab.get("revises", 0),
                duration_ms=duration_ms,
                error=result.get("error"),
            )

            # Persist INSIDE the trace scope so the post-turn tail (cost.recorded,
            # obs.turn_spans, turn-metrics/snapshot/title warnings) inherits this turn's
            # trace_id / turn_id from the log context — otherwise those lines fire after
            # the scope closes and lose the single 全链路 join key (conversation-logs.mdc).
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
        finally:
            if lease_stop is not None:
                lease_stop.set()
            if heartbeat_task is not None:
                heartbeat_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await heartbeat_task
            # Terminal / pause / cancel all clear the RUNNING lease (paused_turns owns pause).
            if settings.turn_lease_enabled:
                await release_turn_lease(message_id)
