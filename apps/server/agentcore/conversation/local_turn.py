"""Sidecar local-turn write-back (双模式工作区 §一.1)."""

from sqlalchemy.exc import IntegrityError

from agentcore.conversation.common import generate_title
from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, MessageRepository
from agentcore.llm.byok import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.memory.consolidation import schedule_consolidation
from agentcore.runtime.journal import journal_entries_from_display_runs, persist_turn_journal

logger = get_logger(__name__)


async def _recorded_turn_response(
    *, conversation_id: str, user_message_id: str, message_id: str | None
) -> dict:
    """Build ``record_local_turn``'s response from already-persisted rows (a retry hit)."""
    async with async_session_factory() as session:
        assistant_id: str | None = None
        if message_id:
            assistant = await MessageRepository(session).get_by_id(
                message_id, conversation_id=conversation_id
            )
            assistant_id = assistant.id if assistant else None
        conv = await ConversationRepository(session).get_by_id(conversation_id)
    return {
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_id,
        "title": conv.title if conv else None,
    }


async def record_local_turn(
    *,
    conversation_id: str,
    user_id: str,
    user_message: str,
    assistant_content: str,
    assistant_reasoning: str | None = None,
    citations: list[dict] | None = None,
    runs: dict | None = None,
    user_message_id: str,
    message_id: str | None = None,
    input_tokens: int = 0,
    output_tokens: int = 0,
    rounds: int = 0,
    trace_id: str,
    llm_credentials: LLMCredentials | None = None,
) -> dict:
    """Persist a turn that ran on the user's machine via the sidecar."""
    with log_context(trace_id=trace_id, conversation_id=conversation_id, user_id=user_id):
        async with async_session_factory() as session:
            already = await MessageRepository(session).get_by_id(
                user_message_id, conversation_id=conversation_id
            )
        if already is not None:
            logger.info(
                "chat.local_turn_idempotent_hit",
                conversation_id=conversation_id,
                message_id=message_id,
            )
            return await _recorded_turn_response(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                message_id=message_id,
            )

        try:
            async with async_session_factory() as session:
                user_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="user",
                    content=user_message,
                    message_id=user_message_id,
                )
        except IntegrityError:
            logger.info(
                "chat.local_turn_idempotent_race",
                conversation_id=conversation_id,
                message_id=message_id,
            )
            return await _recorded_turn_response(
                conversation_id=conversation_id,
                user_message_id=user_message_id,
                message_id=message_id,
            )

        assistant_message_id: str | None = None
        if assistant_content:
            async with async_session_factory() as session:
                assistant_msg = await MessageRepository(session).create(
                    conversation_id=conversation_id,
                    role="assistant",
                    content=assistant_content,
                    reasoning_content=assistant_reasoning,
                    citations=citations,
                    message_id=message_id,
                    trace_id=trace_id,
                    metadata={
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                        "rounds": rounds,
                    },
                )
                assistant_message_id = assistant_msg.id
                await persist_turn_journal(
                    session,
                    message_id=assistant_msg.id,
                    conversation_id=conversation_id,
                    trace_id=trace_id,
                    entries=journal_entries_from_display_runs(runs),
                )

        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id)
            needs_title = bool(conv and not conv.title)

        title: str | None = None
        if needs_title:
            provider = build_provider(llm_credentials)
            try:
                title = await generate_title(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_content,
                )
            finally:
                await provider.close()
            if title:
                async with async_session_factory() as session:
                    await ConversationRepository(session).update_title(conversation_id, title)

        schedule_consolidation(conversation_id)

        logger.info(
            "chat.local_turn_recorded",
            conversation_id=conversation_id,
            message_id=message_id,
            chars=len(assistant_content or ""),
            rounds=rounds,
        )
        return {
            "user_message_id": user_msg.id,
            "assistant_message_id": assistant_message_id,
            "title": title,
        }
