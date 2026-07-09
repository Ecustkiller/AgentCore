"""Sidecar local-turn write-back (双模式工作区 §一.1)."""

from sqlalchemy.exc import IntegrityError

from agentcore.conversation.common import generate_title
from agentcore.core.log_context import log_context
from agentcore.core.logging import get_logger
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import ConversationRepository, MessageRepository
from agentcore.llm.factory import build_provider
from agentcore.llm.resolve import LLMCredentials, resolve_turn_model
from agentcore.memory.consolidation import schedule_consolidation
from agentcore.runtime.events import FinishReason
from agentcore.runtime.journal import journal_entries_from_display_runs, persist_turn_journal

logger = get_logger(__name__)

_SKIP_DERIVED_FINISH = frozenset({FinishReason.PAUSED.value, FinishReason.ERROR.value})


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
        conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
    return {
        "user_message_id": user_message_id,
        "assistant_message_id": assistant_id,
        "title": conv.title if conv else None,
    }


def _assistant_usage_paused(assistant) -> bool:
    usage = getattr(assistant, "usage", None) or {}
    return bool(usage.get("paused"))


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
    reasoning_tokens: int = 0,
    cache_hit_tokens: int = 0,
    cache_miss_tokens: int = 0,
    rounds: int = 0,
    trace_id: str,
    finish_reason: str | None = None,
    llm_credentials: LLMCredentials | None = None,
) -> dict:
    """Persist a turn that ran on the user's machine via the sidecar."""
    finish_value = finish_reason
    is_paused = finish_value == FinishReason.PAUSED.value
    skip_derived = finish_value in _SKIP_DERIVED_FINISH

    with log_context(trace_id=trace_id, conversation_id=conversation_id, user_id=user_id):
        async with async_session_factory() as session:
            msg_repo = MessageRepository(session)
            existing_user = await msg_repo.get_by_id(
                user_message_id, conversation_id=conversation_id
            )
            existing_assistant = (
                await msg_repo.get_by_id(message_id, conversation_id=conversation_id)
                if message_id
                else None
            )

        # A retried completion write-back whose rows already landed — return the same ids.
        # Resume completion is NOT this path: the pause snapshot leaves ``paused`` on usage.
        if (
            existing_user is not None
            and existing_assistant is not None
            and not is_paused
            and not _assistant_usage_paused(existing_assistant)
        ):
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

        turn_user = existing_user
        if turn_user is None and existing_assistant is not None and message_id:
            # Re-pause / resume write-backs reuse the pipeline assistant id but may mint a
            # fresh client user id — bind to the user row from the first write-back.
            async with async_session_factory() as session:
                turn_user = await MessageRepository(session).user_message_for_assistant(
                    conversation_id=conversation_id,
                    assistant_message_id=message_id,
                )
            if turn_user is not None:
                logger.info(
                    "chat.local_turn_reuse_paired_user",
                    conversation_id=conversation_id,
                    message_id=message_id,
                    user_message_id=turn_user.id,
                )

        user_msg_id = turn_user.id if turn_user is not None else user_message_id
        if turn_user is None:
            try:
                async with async_session_factory() as session:
                    user_msg = await MessageRepository(session).create(
                        conversation_id=conversation_id,
                        role="user",
                        content=user_message,
                        message_id=user_message_id,
                    )
                    user_msg_id = user_msg.id
            except IntegrityError:
                logger.info(
                    "chat.local_turn_idempotent_race",
                    conversation_id=conversation_id,
                    message_id=message_id,
                )
                user_msg_id = user_message_id

        assistant_message_id: str | None = None
        usage_metadata = {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "reasoning_tokens": reasoning_tokens,
            "cache_hit_tokens": cache_hit_tokens,
            "cache_miss_tokens": cache_miss_tokens,
            "rounds": rounds,
        }
        if is_paused:
            usage_metadata["paused"] = True

        if message_id and (assistant_content or is_paused):
            async with async_session_factory() as session:
                assistant_msg = await MessageRepository(session).upsert_assistant(
                    conversation_id=conversation_id,
                    message_id=message_id,
                    content=assistant_content,
                    reasoning_content=assistant_reasoning,
                    citations=citations,
                    trace_id=trace_id,
                    metadata=usage_metadata,
                )
                assistant_message_id = assistant_msg.id
                if not is_paused and runs is not None:
                    await persist_turn_journal(
                        session,
                        message_id=assistant_msg.id,
                        conversation_id=conversation_id,
                        trace_id=trace_id,
                        entries=journal_entries_from_display_runs(runs),
                    )

        if skip_derived:
            logger.info(
                "chat.local_turn_recorded",
                conversation_id=conversation_id,
                message_id=message_id,
                finish_reason=finish_value,
                chars=len(assistant_content or ""),
                rounds=rounds,
            )
            return {
                "user_message_id": user_msg_id,
                "assistant_message_id": assistant_message_id,
                "title": None,
            }

        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            needs_title = bool(conv and not conv.title)

        title: str | None = None
        tag: str | None = None
        if needs_title:
            provider = build_provider(llm_credentials)
            try:
                minted = await generate_title(
                    provider=provider,
                    conversation_id=conversation_id,
                    user_message=user_message,
                    assistant_reply=assistant_content,
                    # Title on the SAME model the provider was built for. Otherwise
                    # generate_title falls back to settings.platform_model, so a BYOK
                    # provider (e.g. DeepSeek) is handed a gpt-5.5 model name and the
                    # upstream 400s ("supported models are deepseek-…, not gpt-5.5").
                    model=resolve_turn_model(llm_credentials),
                )
                title = minted.title
                tag = minted.tag
            finally:
                await provider.close()
            if title:
                async with async_session_factory() as session:
                    await ConversationRepository(session).update_title_unscoped(
                        conversation_id, title, tag=tag
                    )

        schedule_consolidation(conversation_id)

        logger.info(
            "chat.local_turn_recorded",
            conversation_id=conversation_id,
            message_id=message_id,
            chars=len(assistant_content or ""),
            rounds=rounds,
        )
        return {
            "user_message_id": user_msg_id,
            "assistant_message_id": assistant_message_id,
            "title": title,
        }
