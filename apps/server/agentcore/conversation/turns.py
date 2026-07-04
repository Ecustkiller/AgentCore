"""Cloud SSE turn entry points: send, regenerate, durable resume."""

import asyncio
import time

from agentcore.conversation.common import (
    preview,
    resolve_local_binding,
    resolve_memory_enabled,
    resolve_profile_set,
)
from agentcore.conversation.history import load_chat_context
from agentcore.conversation.turn_backend import build_turn_backend
from agentcore.conversation.turn_persistence import persist_turn_result, salvage_incomplete_turn
from agentcore.conversation.turn_runner import (
    run_and_persist,
    session_callbacks,
    suspension_callbacks,
)
from agentcore.core.error_codes import ErrorCode
from agentcore.core.errors import error_fields_for
from agentcore.core.log_context import log_context, new_trace_id
from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import (
    BoardRepository,
    ConversationRepository,
    MessageRepository,
)
from agentcore.llm.byok import LLMCredentials
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import EventSink, FinishReason, error_event, message_end, turn_saved
from agentcore.runtime.pipeline import resume_chat_pipeline
from agentcore.runtime.suspension import TurnSuspension
from agentcore.workspace.attachments import persist_attachments, to_stored_metadata
from agentcore.workspace.locate import workspace_storage_key
from agentcore.workspace.locks import workspace_lock

logger = get_logger(__name__)


async def stream_chat(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    sink: EventSink,
    attachments: list[dict] | None = None,
    llm_credentials: LLMCredentials | None = None,
    debate_seed: dict | None = None,
) -> None:
    """Main entry: persist user message, run pipeline, persist assistant reply.

    ``debate_seed`` (结构化补轮·B): when the desktop starts a 续辩 from a settled debate
    card, it carries the prior debate's projected result so this turn's debate continues
    the prior one (threaded to the DebateTool). ``None`` for an ordinary message.
    """
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            if not conv:
                sink.emit(error_event(ErrorCode.NOT_FOUND, "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            title = conv.title
            instructions = conv.instructions
            local_container_root_id = conv.local_container_root_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            memory_enabled = await resolve_memory_enabled(session, user_id)
            # AI 协作白板 (§六 M2): if this conversation is a board's dedicated thread, the
            # turn is a 白板会话 — hand its board id to the pipeline so the CEO gets board_ops.
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            sink=sink,
            local_binding=local_binding,
        )

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=None, conversation_id=conversation_id
            )
        ):
            resident_attachments = await persist_attachments(backend, attachments)

            async with async_session_factory() as session:
                user_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="user",
                    content=user_message,
                    attachments=to_stored_metadata(resident_attachments),
                )
                history = await load_chat_context(session, conversation_id, max_messages=40)

            sink.emit(turn_saved(user_message_id=user_msg.id))

            await run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=folder_id,
                sink=sink,
                history=history[:-1],
                attachments=resident_attachments,
                backend=backend,
                generate_title=True,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
                memory_enabled=memory_enabled,
                instructions=instructions,
                board_id=board_id,
                debate_seed=debate_seed,
            )

    except Exception as e:
        logger.error("chat.stream_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


async def regenerate_chat(
    *,
    conversation_id: str,
    message_id: str,
    user_id: str,
    sink: EventSink,
    edited_content: str | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Re-run a turn from an existing user message (regenerate / edit-and-resend)."""
    try:
        async with async_session_factory() as session:
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conv = await conv_repo.get_by_id_unscoped(conversation_id)
            if not conv:
                sink.emit(error_event(ErrorCode.NOT_FOUND, "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            target = await msg_repo.get_by_id(message_id, conversation_id=conversation_id)
            if not target or target.role != "user":
                sink.emit(error_event(ErrorCode.INVALID, "Can only regenerate from a user message"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            if edited_content is not None:
                await msg_repo.update_content(message_id, edited_content)

            await msg_repo.delete_after(conversation_id, after_created_at=target.created_at)

            user_message = edited_content if edited_content is not None else (target.content or "")
            history = await load_chat_context(session, conversation_id, max_messages=40)
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            memory_enabled = await resolve_memory_enabled(session, user_id)
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            sink=sink,
            local_binding=local_binding,
        )

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id,
                folder_id=None,
                conversation_id=conversation_id,
            )
        ):
            await run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=conv.folder_id,
                sink=sink,
                history=history[:-1],
                attachments=None,
                backend=backend,
                generate_title=False,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
                memory_enabled=memory_enabled,
                instructions=conv.instructions,
                board_id=board_id,
            )

    except Exception as e:
        logger.error("chat.regenerate_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


async def resume_chat(
    *,
    suspension: TurnSuspension,
    response: CheckpointResponse,
    sink: EventSink,
    llm_credentials: LLMCredentials | None = None,
) -> None:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume)."""
    conversation_id = suspension.conversation_id
    user_id = suspension.user_id
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            if not conv:
                sink.emit(error_event(ErrorCode.NOT_FOUND, "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            title = conv.title
            local_container_root_id = conv.local_container_root_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            history = await load_chat_context(session, conversation_id, max_messages=40)
            # AI 协作白板 (§六 M2): re-derive the board binding (authoritative in the DB, not
            # carried in the frame) so a board turn paused at a checkpoint regains board_ops
            # on resume — symmetric with the send path's lookup in ``stream_chat``.
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            sink=sink,
            local_binding=local_binding,
        )
        session_saver, session_loader = session_callbacks(conversation_id)
        suspension_saver, suspension_deleter = suspension_callbacks()

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=None, conversation_id=conversation_id
            )
        ):
            trace_id = suspension.trace_id or new_trace_id()
            turn_id = new_id()
            started = time.monotonic()
            with log_context(
                trace_id=trace_id,
                conversation_id=conversation_id,
                user_id=user_id,
                turn_id=turn_id,
                agent_id="CEO",
            ):
                logger.info(
                    "chat.resume_start",
                    message_id=suspension.message_id,
                    kind=suspension.kind.value,
                    decision=response.decision.value,
                    seeded=len(getattr(suspension, "completed", {})),
                )
                try:
                    result = await resume_chat_pipeline(
                        suspension=suspension,
                        decision=response.decision,
                        note=response.note,
                        selected=response.selected,
                        sink=sink,
                        backend=backend,
                        history=history[:-1],
                        board_id=board_id,
                        llm_credentials=llm_credentials,
                        profile_set=profile_set,
                        session_saver=session_saver,
                        session_loader=session_loader,
                        suspension_saver=suspension_saver,
                        suspension_deleter=suspension_deleter,
                    )
                except asyncio.CancelledError:
                    salvage_incomplete_turn(
                        sink=sink,
                        conversation_id=conversation_id,
                        trace_id=trace_id,
                        message_id=suspension.message_id,
                    )
                    raise
                finish = result.get("finish_reason")
                cost_runs = result.get("cost_runs") or []
                duration_ms = int((time.monotonic() - started) * 1000)
                workers = max(len(cost_runs) - 1, 0)
                logger.info(
                    "chat.resume_complete",
                    finish_reason=getattr(finish, "value", finish),
                    rounds=result.get("rounds", 0),
                    reply_chars=len(result.get("content") or ""),
                    reply_preview=preview(result.get("content") or ""),
                    delegated=workers > 0,
                    workers=workers,
                    duration_ms=duration_ms,
                    error=result.get("error"),
                )

                # Persist INSIDE the trace scope (same as run_and_persist) so the
                # resumed turn's tail (cost.recorded / obs.turn_spans / metrics)
                # inherits trace_id / turn_id instead of losing the join key.
                await persist_turn_result(
                    result=result,
                    conversation_id=conversation_id,
                    user_id=user_id,
                    folder_id=folder_id,
                    backend=backend,
                    sink=sink,
                    user_message=suspension.user_message,
                    generate_title=True,
                    llm_credentials=llm_credentials,
                    trace_id=trace_id,
                    turn_id=turn_id,
                    duration_ms=duration_ms,
                    kind="resume",
                )

    except Exception as e:
        logger.error("chat.resume_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()
