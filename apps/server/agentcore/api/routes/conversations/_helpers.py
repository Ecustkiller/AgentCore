"""Shared helpers for the conversation route modules.

Kept in one private module so the domain route modules (crud / messages / handoff
/ …) can share the owner-scoping guards and the pre-turn billing gate. The package
``__init__`` re-exports ``_preflight_turn_llm`` so the historical import path
``from agentcore.api.routes.conversations import _preflight_turn_llm`` keeps working.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.config import settings
from agentcore.conversation.quota import QuotaLimits, enforce_quota
from agentcore.core.errors import BYOKKeyMissingError, NotFoundError
from agentcore.db.models import Conversation, User
from agentcore.db.repositories import ConversationRepository, CostEventRepository
from agentcore.llm.byok import LLMCredentials, resolve_user_llm_credentials


async def _require_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> None:
    """404 unless the conversation exists and belongs to the user."""
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("对话不存在")


async def _get_owned_conversation(
    conversation_id: str, user_id: str, repo: ConversationRepository
) -> Conversation:
    """Return the conversation (for its ``folder_id``) or 404 if not owned.

    Snapshot routes need ``folder_id`` to resolve the right workspace: a folder's
    conversations share its space; an ungrouped one has its own (workspace.locate).
    """
    conv = await repo.get_by_id(conversation_id, user_id=user_id)
    if not conv:
        raise NotFoundError("对话不存在")
    return conv


async def _preflight_turn_llm(
    *,
    session: AsyncSession,
    user: User,
    cost_repo: CostEventRepository,
) -> LLMCredentials | None:
    """Pre-turn billing gate, run before the SSE opens so a refused turn gets a
    clean error instead of a half-opened stream.

    BYOK mode (config.billing_mode): require the user's own DeepSeek key and return
    the resolved credentials to thread through the turn — refuse with
    ``BYOKKeyMissingError`` (→ 402 LLM_KEY_REQUIRED) when none is configured, so the
    client routes the user to 设置·模型配置. Platform mode: keep the quota 防线 and
    return ``None`` (the turn runs on the global server key). Resolving here and
    threading the result down means "preflight passes" == "the turn runs on this
    key" — the runtime never re-resolves to a different decision.
    """
    if settings.billing_mode == "byok":
        credentials = await resolve_user_llm_credentials(session, user.user_id)
        if credentials is None:
            raise BYOKKeyMissingError(
                "请先在「设置 · 模型配置」中填入你的 DeepSeek API Key，再发起对话。"
            )
        return credentials
    await enforce_quota(cost_repo, user.user_id, limits=QuotaLimits.for_user(user))
    return None
