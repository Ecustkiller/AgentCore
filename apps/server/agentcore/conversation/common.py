"""Shared helpers for conversation turn orchestration."""

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.core.logging import get_logger
from agentcore.db.models import Conversation
from agentcore.db.repositories import FolderRepository, ModelModeRepository, UserRepository
from agentcore.llm.deepseek import DeepSeekProvider
from agentcore.llm.modes import ProfileSet
from agentcore.llm.modes import resolve_profile_set as resolve_mode_profile_set
from agentcore.memory import (
    TITLE_MAX_CHARS,
    ChatMessage,
    FollowupInput,
    LLMFollowupsGenerator,
    LLMTitleGenerator,
    TitleInput,
)
from agentcore.workspace.locate import LocalBinding
from agentcore.workspace.locate import resolve_local_binding as locate_local_binding

logger = get_logger(__name__)


def log_cost_recorded(conversation_id: str, message_id: str | None, cost_runs: list[dict]) -> None:
    """Emit ``cost.recorded`` after a turn's ledger rows persist successfully."""
    total_nano = sum(int(r.get("cost_total_nano", 0) or 0) for r in cost_runs)
    models = sorted({str(r.get("model", "?")) for r in cost_runs})
    logger.info(
        "cost.recorded",
        conversation_id=conversation_id,
        message_id=message_id,
        runs=len(cost_runs),
        total_nano=total_nano,
        total_usd=round(total_nano / 1e9, 6),
        models=models,
    )


def fallback_title(user_message: str) -> str:
    """Naive title: the first user message, truncated."""
    title = user_message.strip()
    return title[:TITLE_MAX_CHARS] + "…" if len(title) > TITLE_MAX_CHARS else title


def preview(text: str, *, limit: int = 80) -> str:
    """Single-line, length-capped preview of message text for a log field."""
    collapsed = " ".join((text or "").split())
    return collapsed[:limit] + "…" if len(collapsed) > limit else collapsed


async def resolve_local_binding(session: AsyncSession, conv: Conversation) -> LocalBinding | None:
    """Resolve a turn's local-mode binding (双模式工作区 §七), or None for cloud."""
    folder = None
    if conv.folder_id:
        folder = await FolderRepository(session).get_by_id(conv.folder_id)
    return locate_local_binding(
        folder_id=conv.folder_id,
        folder_local_root_id=folder.local_root_id if folder else None,
        folder_local_subpath=folder.local_subpath if folder else None,
        label=folder.name if folder else None,
    )


async def generate_title(
    *,
    provider: DeepSeekProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
) -> str:
    """Best-effort one-line title via the fast model; falls back to truncation."""
    fallback = fallback_title(user_message)
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
        logger.warning("chat.title_failed", conversation_id=conversation_id, error=str(e))
        return fallback


async def generate_followups(
    *,
    provider: DeepSeekProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
) -> list[str]:
    """Best-effort turn-level「下一步」suggestions; returns ``[]`` on any failure.

    Pure garnish (CEO→user quick-reply chips), so every failure mode — empty input,
    empty model output, timeout, network/parse error — collapses to「no chips」and is
    swallowed here; it never blocks or fails the turn it garnishes.
    """
    if not assistant_reply.strip():
        return []

    messages: list[ChatMessage] = []
    if user_message.strip():
        messages.append({"role": "user", "content": user_message})
    messages.append({"role": "assistant", "content": assistant_reply})

    try:
        return await LLMFollowupsGenerator(provider).generate(
            FollowupInput(conversation_id=conversation_id, messages=messages)
        )
    except Exception as e:
        logger.warning("chat.followups_failed", conversation_id=conversation_id, error=str(e))
        return []


async def resolve_profile_set(
    session: AsyncSession, conv: Conversation, user_id: str
) -> ProfileSet:
    """Resolve this turn's 质量档 (llm/modes.py)."""
    user = await UserRepository(session).get_by_id(user_id)
    mode_ref = (
        conv.model_mode
        or (user.default_model_mode if user else None)
        or settings.default_model_mode
    )
    custom_modes = await ModelModeRepository(session).assignments_by_user(user_id)
    return resolve_mode_profile_set(
        mode_ref, custom_modes=custom_modes, ceiling=settings.selectable_models
    )


async def resolve_memory_enabled(session: AsyncSession, user_id: str) -> bool:
    """This turn's long-term-memory master switch (Agent记忆与知识系统 §一).

    Defaults to True for an unknown user (memory on, the product default), so a
    missing row never silently suppresses injection.
    """
    user = await UserRepository(session).get_by_id(user_id)
    return user.memory_enabled if user else True
