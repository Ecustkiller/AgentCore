"""Cloud SSE turn entry points: send, regenerate, durable resume."""

import asyncio
import contextlib
import time

from agentcore.config import settings
from agentcore.conversation.common import (
    preview,
    resolve_local_binding,
    resolve_memory_enabled,
    resolve_permission_preset,
    resolve_profile_set,
    schedule_title_generation,
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
from agentcore.core.types import new_id, preset_to_autonomy
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import (
    BoardRepository,
    ConversationRepository,
    MessageRepository,
    TurnJournalRepository,
)
from agentcore.llm.resolve import LLMCredentials
from agentcore.runtime.checkpoints import CheckpointResponse
from agentcore.runtime.events import EventSink, FinishReason, error_event, message_end, turn_saved
from agentcore.runtime.leases import (
    acquire_turn_lease,
    lease_heartbeat_loop,
    release_turn_lease,
)
from agentcore.runtime.pipeline import resume_chat_pipeline
from agentcore.runtime.retry import retry_failed_targets, retry_seed
from agentcore.runtime.runs.types import RunPhase
from agentcore.runtime.suspension import TurnSuspension
from agentcore.runtime.suspension_persistence import restore_paused_turn
from agentcore.runtime.turn_state import TurnState
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
    llm_supports_tools: bool | None = None,
    x_client_platform: str | None = None,
) -> None:
    """Main entry: persist user message, run pipeline, persist assistant reply.
    """
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            if not conv:
                sink.emit(error_event(ErrorCode.NOT_FOUND, "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            memory_enabled = await resolve_memory_enabled(session, user_id)
            permission_preset = await resolve_permission_preset(session, conversation_id)
            autonomy_policy = preset_to_autonomy(permission_preset)
            # AI 协作白板 (§六 M2): if this conversation is a board's dedicated thread, the
            # turn is a 白板会话 — hand its board id to the pipeline so the CEO gets board_ops.
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            folder_id=folder_id,
            sink=sink,
            local_binding=local_binding,
        )

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
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

            # Cloud early title: fire-and-forget in parallel with the turn (user message
            # only). Skip when the conversation already has a title (manual rename).
            if not (conv.title and str(conv.title).strip()):
                schedule_title_generation(
                    conversation_id=conversation_id,
                    user_id=user_id,
                    user_message=user_message,
                    sink=sink,
                )

            await run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=folder_id,
                sink=sink,
                history=history[:-1],
                attachments=resident_attachments,
                backend=backend,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
                memory_enabled=memory_enabled,
                autonomy_policy=autonomy_policy,
                permission_preset=permission_preset,
                board_id=board_id,
                llm_supports_tools=llm_supports_tools,
                x_client_platform=x_client_platform,
            )

    except Exception as e:
        logger.error("chat.stream_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message, err_ctx = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message, context=err_ctx))
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
    llm_supports_tools: bool | None = None,
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
            folder_id = conv.folder_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            memory_enabled = await resolve_memory_enabled(session, user_id)
            permission_preset = await resolve_permission_preset(session, conversation_id)
            autonomy_policy = preset_to_autonomy(permission_preset)
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            folder_id=folder_id,
            sink=sink,
            local_binding=local_binding,
        )

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
            )
        ):
            await run_and_persist(
                conversation_id=conversation_id,
                user_message=user_message,
                user_id=user_id,
                folder_id=folder_id,
                sink=sink,
                history=history[:-1],
                attachments=None,
                backend=backend,
                llm_credentials=llm_credentials,
                profile_set=profile_set,
                memory_enabled=memory_enabled,
                autonomy_policy=autonomy_policy,
                permission_preset=permission_preset,
                board_id=board_id,
                llm_supports_tools=llm_supports_tools,
            )

    except Exception as e:
        logger.error("chat.regenerate_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message, err_ctx = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message, context=err_ctx))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if not sink._closed:
            sink.close()


async def _extract_completed_seed(
    session,
    msg_repo: MessageRepository,
    conversation_id: str,
    user_msg,
) -> tuple[dict | None, list[dict[str, str | None]]]:
    """Extract completed worker RunStates from the assistant turn's journal.

    Returns ``(seed, failed_targets)`` where seed is run_id -> RunState for workers
    that completed successfully, and failed_targets lists non-completed workers for
    retry-failed audit (run_id + error summary).
    """
    assistant_msg = await msg_repo.get_assistant_after(
        conversation_id, after_created_at=user_msg.created_at
    )
    if not assistant_msg:
        return None, []

    entries = await TurnJournalRepository(session).load_owned(assistant_msg.id, conversation_id)
    if not entries:
        return None, []

    # Internal dedup: same projection entry as resume / crash recover (behaviour unchanged).
    all_states = TurnState.from_journal(entries).completed
    seed = {
        run_id: state
        for run_id, state in all_states.items()
        if state.phase == RunPhase.COMPLETED
    }
    failed_targets = [
        {
            "run_id": run_id,
            "error": str(state.error)[:500] if state.error else None,
        }
        for run_id, state in all_states.items()
        if state.phase != RunPhase.COMPLETED
    ]
    return (seed if seed else None), failed_targets


async def retry_failed_chat(
    *,
    conversation_id: str,
    message_id: str,
    user_id: str,
    sink: EventSink,
    llm_credentials: LLMCredentials | None = None,
    llm_supports_tools: bool | None = None,
) -> None:
    """Retry only failed workers from a previous turn (重试失败项).

    Like regenerate, but extracts completed worker RunStates from the previous
    turn's journal and sets them on the retry_seed contextvar. When the CEO
    re-delegates, DelegateTool reads the seed and passes it as seed_completed
    to WaveScheduler, skipping already-succeeded workers.
    """
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
                sink.emit(error_event(ErrorCode.INVALID, "Can only retry from a user message"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            seed, failed_targets = await _extract_completed_seed(
                session, msg_repo, conversation_id, target
            )

            await msg_repo.delete_after(conversation_id, after_created_at=target.created_at)

            user_message = target.content or ""
            history = await load_chat_context(session, conversation_id, max_messages=40)
            folder_id = conv.folder_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            memory_enabled = await resolve_memory_enabled(session, user_id)
            permission_preset = await resolve_permission_preset(session, conversation_id)
            autonomy_policy = preset_to_autonomy(permission_preset)
            board = await BoardRepository(session).get_by_conversation_id(
                conversation_id, user_id=user_id
            )
            board_id = board.id if board else None

        backend = build_turn_backend(
            user_id=user_id,
            conversation_id=conversation_id,
            folder_id=folder_id,
            sink=sink,
            local_binding=local_binding,
        )

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id,
                folder_id=folder_id,
                conversation_id=conversation_id,
            )
        ):
            token = retry_seed.set(seed)
            targets_token = retry_failed_targets.set(failed_targets or None)
            try:
                await run_and_persist(
                    conversation_id=conversation_id,
                    user_message=user_message,
                    user_id=user_id,
                    folder_id=folder_id,
                    sink=sink,
                    history=history[:-1],
                    attachments=None,
                    backend=backend,
                    llm_credentials=llm_credentials,
                    profile_set=profile_set,
                    memory_enabled=memory_enabled,
                    autonomy_policy=autonomy_policy,
                    permission_preset=permission_preset,
                    board_id=board_id,
                    llm_supports_tools=llm_supports_tools,
                )
            finally:
                retry_seed.reset(token)
                retry_failed_targets.reset(targets_token)

    except Exception as e:
        logger.error("chat.retry_failed_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message, err_ctx = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message, context=err_ctx))
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
    llm_supports_tools: bool | None = None,
    x_client_platform: str | None = None,
) -> None:
    """Continue a turn paused at a plan_review / ask_user checkpoint (结构化挂起 2b resume).

    The route already claimed (DELETE) the ``paused_turns`` row. On resume failure /
    cancel the frame is re-upserted so the user can retry — sidecar ``rollback_claim``
    parity for the cloud path. Success and a fresh re-pause (new frame already saved)
    leave the claim deleted.
    """
    conversation_id = suspension.conversation_id
    user_id = suspension.user_id
    # Default: restore the claimed frame. Cleared only on success / re-pause.
    restore_frame = True
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            if not conv:
                sink.emit(error_event(ErrorCode.NOT_FOUND, "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return
            folder_id = conv.folder_id
            local_binding = await resolve_local_binding(session, conv)
            profile_set = await resolve_profile_set(session, conv, user_id)
            # Conversation permission mode (not frozen into the frame): a mid-pause
            # switch applies to the resumed continuation.
            permission_preset = await resolve_permission_preset(session, conversation_id)
            autonomy_policy = preset_to_autonomy(permission_preset)
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
            folder_id=folder_id,
            sink=sink,
            local_binding=local_binding,
        )
        session_saver, session_loader = session_callbacks(conversation_id)
        suspension_saver, suspension_deleter = suspension_callbacks()

        async with workspace_lock(
            workspace_storage_key(
                user_id=user_id, folder_id=folder_id, conversation_id=conversation_id
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
                message_id=suspension.message_id,
                agent_id="CEO",
                cost_role="captain",
                persona="CEO",
            ):
                logger.info(
                    "chat.resume_start",
                    message_id=suspension.message_id,
                    kind=suspension.kind.value,
                    decision=response.decision.value,
                    seeded=len(getattr(suspension, "completed", {})),
                )
                sink.bind_content_checkpoint(
                    conversation_id=conversation_id,
                    message_id=suspension.message_id,
                )
                lease_stop: asyncio.Event | None = None
                heartbeat_task: asyncio.Task | None = None
                if settings.turn_lease_enabled:
                    owner_id = await acquire_turn_lease(
                        message_id=suspension.message_id,
                        conversation_id=conversation_id,
                        user_id=user_id,
                        phase="resuming",
                        meta={"trace_id": trace_id, "kind": suspension.kind.value},
                    )
                    lease_stop = asyncio.Event()
                    heartbeat_task = asyncio.create_task(
                        lease_heartbeat_loop(
                            suspension.message_id,
                            owner_id=owner_id,
                            interval_seconds=settings.turn_lease_heartbeat_seconds,
                            stop=lease_stop,
                            phase="resuming",
                        )
                    )
                try:
                    try:
                        from agentcore.demo_tape.hooks import run_tape_resume_if_marked

                        tape_result = await run_tape_resume_if_marked(
                            suspension=suspension,
                            response=response,
                            sink=sink,
                            folder_id=folder_id,
                            trace_id=trace_id,
                        )
                        if tape_result is not None:
                            result = tape_result
                        else:
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
                                llm_supports_tools=llm_supports_tools,
                                autonomy_policy=autonomy_policy,
                                permission_preset=permission_preset,
                                x_client_platform=x_client_platform,
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
                    finish_value = getattr(finish, "value", finish)
                    cost_runs = result.get("cost_runs") or []
                    duration_ms = int((time.monotonic() - started) * 1000)
                    workers = max(len(cost_runs) - 1, 0)
                    logger.info(
                        "chat.resume_complete",
                        finish_reason=finish_value,
                        rounds=result.get("rounds", 0),
                        reply_chars=len(result.get("content") or ""),
                        reply_preview=preview(result.get("content") or ""),
                        delegated=workers > 0,
                        workers=workers,
                        duration_ms=duration_ms,
                        error=result.get("error"),
                    )
                    # Decide restore BEFORE persist: a successful / re-paused pipeline must
                    # not re-upsert the old frame even if the post-turn persist raises.
                    if finish_value == FinishReason.PAUSED.value or (
                        not result.get("error") and finish_value != FinishReason.ERROR.value
                    ):
                        restore_frame = False

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
                        llm_credentials=llm_credentials,
                        trace_id=trace_id,
                        turn_id=turn_id,
                        duration_ms=duration_ms,
                        kind="resume",
                    )
                finally:
                    if lease_stop is not None:
                        lease_stop.set()
                    if heartbeat_task is not None:
                        heartbeat_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat_task
                    if settings.turn_lease_enabled:
                        await release_turn_lease(suspension.message_id)

    except Exception as e:
        logger.error("chat.resume_error", error=str(e), exc_info=True)
        if not sink._closed:
            code, message, err_ctx = error_fields_for(
                e,
                fallback_code=ErrorCode.STREAM_ERROR,
                fallback_message="服务出错了，请稍后重试。",
            )
            sink.emit(error_event(code, message, context=err_ctx))
            sink.emit(message_end(FinishReason.ERROR))
    finally:
        if restore_frame:
            await restore_paused_turn(suspension)
        if not sink._closed:
            sink.close()
