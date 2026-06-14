"""ConversationService: stream_chat entry point.

Coordinates message persistence, history loading, pipeline execution,
and title generation for a conversation turn.
"""

from agentcore.conversation.history import load_history
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, MessageRepository
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.factory import build_provider
from agentcore.memory import (
    TITLE_MAX_CHARS,
    ChatMessage,
    LLMMemoryExtractor,
    LLMTitleGenerator,
    TitleInput,
    default_memory_store,
    maintain_user_memory,
)
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    error_event,
    message_end,
    title_generated,
    turn_saved,
)
from agentcore.runtime.pipeline import run_chat_pipeline

logger = get_logger(__name__)


def _fallback_title(user_message: str) -> str:
    """Naive title: the first user message, truncated."""
    title = user_message.strip()
    return title[:TITLE_MAX_CHARS] + "…" if len(title) > TITLE_MAX_CHARS else title


async def _generate_title(
    *,
    provider: DeepSeekProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
) -> str:
    """Best-effort one-line title via the fast model; falls back to truncation.

    Any failure degrades to the naive truncated title. The provider is shared by
    the caller (also used for memory maintenance) and closed there.
    """
    fallback = _fallback_title(user_message)
    if not user_message.strip():
        return fallback

    messages: list[ChatMessage] = [{"role": "user", "content": user_message}]
    if assistant_reply.strip():
        messages.append({"role": "assistant", "content": assistant_reply})

    try:
        title = await LLMTitleGenerator(provider).generate(
            TitleInput(conversation_id=conversation_id, messages=messages)
        )
        return title or fallback
    except Exception as e:
        logger.warning("title_generation_failed", conversation_id=conversation_id, error=str(e))
        return fallback


async def _run_and_persist(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    sink: EventSink,
    history: list[dict],
    attachments: list[dict] | None,
    generate_title: bool,
) -> None:
    """Run the pipeline, persist the assistant reply, then title + memory.

    Shared tail of both first-time sends and regenerate / edit-and-resend.
    `history` is the prior context (already excluding the current user turn).
    Title generation is skipped for regenerate (the conversation already has one).
    The user turn is persisted and reconciled by the caller before this runs.
    """
    result = await run_chat_pipeline(
        conversation_id=conversation_id,
        user_message=user_message,
        history=history,
        sink=sink,
        user_id=user_id,
        attachments=attachments,
    )

    assistant_reply = result.get("content") or ""
    assistant_reasoning = result.get("reasoning_content") or None

    async with async_session_factory() as session:
        msg_repo = MessageRepository(session)
        conv_repo = ConversationRepository(session)

        if assistant_reply:
            await msg_repo.create(
                conversation_id=conversation_id,
                role="assistant",
                content=assistant_reply,
                reasoning_content=assistant_reasoning,
                metadata={
                    "input_tokens": result.get("input_tokens", 0),
                    "output_tokens": result.get("output_tokens", 0),
                    "rounds": result.get("rounds", 0),
                },
            )

        conv = await conv_repo.get_by_id(conversation_id)
        needs_title = bool(generate_title and conv and not conv.title)

    # Title + long-term memory both hit the network and run after the pipeline
    # already emitted message_end, so this latency is not user-visible. They
    # share one provider. The title_generated event is emitted before the sink
    # closes, so the sidebar updates live.
    provider = build_provider()
    try:
        if needs_title:
            title = await _generate_title(
                provider=provider,
                conversation_id=conversation_id,
                user_message=user_message,
                assistant_reply=assistant_reply,
            )
            if title:
                async with async_session_factory() as session:
                    conv_repo = ConversationRepository(session)
                    await conv_repo.update_title(conversation_id, title)
                sink.emit(title_generated(title, conversation_id=conversation_id))

        # Per-turn long-term memory maintenance from this exchange. Skips the
        # write when nothing durable changed; never raises.
        if user_message.strip():
            turn: list[ChatMessage] = [{"role": "user", "content": user_message}]
            if assistant_reply.strip():
                turn.append({"role": "assistant", "content": assistant_reply})
            await maintain_user_memory(
                user_id=user_id,
                messages=turn,
                extractor=LLMMemoryExtractor(provider),
                store=default_memory_store(),
            )
    finally:
        await provider.close()


async def stream_chat(
    *,
    conversation_id: str,
    user_message: str,
    user_id: str,
    sink: EventSink,
    attachments: list[dict] | None = None,
) -> None:
    """Main entry: persist user message, run pipeline, persist assistant reply.

    Creates its own DB session to avoid lifecycle issues with the HTTP request.

    `attachments` are user-referenced files (@-mention / paperclip); their text is
    injected into the model context for this turn only. They are intentionally not
    persisted (no schema column) nor fed to title/memory generation, keeping the
    stored user message and derived title clean.
    """
    try:
        async with async_session_factory() as session:
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conv = await conv_repo.get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            # Persist only display metadata (name/path/truncated); the extracted
            # text is one-shot context and intentionally not stored.
            attachment_meta = [
                {
                    "name": a.get("name"),
                    "path": a.get("path"),
                    "truncated": bool(a.get("truncated")),
                    "kind": a.get("kind") or "file",
                }
                for a in (attachments or [])
            ]
            user_msg = await msg_repo.create(
                conversation_id=conversation_id,
                role="user",
                content=user_message,
                attachments=attachment_meta,
            )

            history = await load_history(session, conversation_id, max_messages=40)

        # Reconcile the optimistic user bubble to its real row id up front, so a
        # retry after a mid-stream failure regenerates from the saved turn rather
        # than resending it (which would duplicate the user message).
        sink.emit(turn_saved(user_message_id=user_msg.id))

        await _run_and_persist(
            conversation_id=conversation_id,
            user_message=user_message,
            user_id=user_id,
            sink=sink,
            history=history[:-1],
            attachments=attachments,
            generate_title=True,
        )

    except Exception as e:
        logger.error("stream_chat_error", error=str(e), exc_info=True)
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
) -> None:
    """Re-run a turn from an existing user message (regenerate / edit-and-resend).

    `message_id` must be a user message in this conversation. When `edited_content`
    is given the message is edited in place first; then every message created after
    it is dropped and the assistant reply is produced anew. Attachments are not
    re-injected (their extracted text is never persisted), and the conversation
    title is left untouched.
    """
    try:
        async with async_session_factory() as session:
            conv_repo = ConversationRepository(session)
            msg_repo = MessageRepository(session)

            conv = await conv_repo.get_by_id(conversation_id)
            if not conv:
                sink.emit(error_event("NOT_FOUND", "Conversation not found"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            target = await msg_repo.get_by_id(message_id, conversation_id=conversation_id)
            if not target or target.role != "user":
                sink.emit(error_event("INVALID", "Can only regenerate from a user message"))
                sink.emit(message_end(FinishReason.ERROR))
                return

            if edited_content is not None:
                await msg_repo.update_content(message_id, edited_content)

            # Drop the superseded assistant reply (and any later turns).
            await msg_repo.delete_after(
                conversation_id, after_created_at=target.created_at
            )

            user_message = (
                edited_content if edited_content is not None else (target.content or "")
            )
            history = await load_history(session, conversation_id, max_messages=40)

        await _run_and_persist(
            conversation_id=conversation_id,
            user_message=user_message,
            user_id=user_id,
            sink=sink,
            history=history[:-1],
            attachments=None,
            generate_title=False,
        )

    except Exception as e:
        logger.error("regenerate_chat_error", error=str(e), exc_info=True)
    finally:
        if not sink._closed:
            sink.close()
