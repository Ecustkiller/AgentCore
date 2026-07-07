"""Shared helpers for the conversation route modules.

Kept in one private module so the domain route modules (crud / messages / handoff
/ …) can share the owner-scoping guards and the pre-turn billing gate. The package
``__init__`` re-exports ``_preflight_turn_llm`` so the historical import path
``from agentcore.api.routes.conversations import _preflight_turn_llm`` keeps working.
"""

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.billing.gate import preflight_llm_credentials
from agentcore.core.errors import NotFoundError
from agentcore.db.models import Conversation, User
from agentcore.db.repositories import (
    ConversationRepository,
    CostEventRepository,
    UserLlmKeyRepository,
)
from agentcore.llm.resolve import LLMCredentials
from agentcore.llm.tools_gate import TOOLS_SOFT_GATE_WARNING
from agentcore.runtime.events import EventSink, turn_warning


@dataclass(frozen=True)
class TurnPreflightResult:
    """Pre-turn billing gate outcome threaded into the SSE pipeline."""

    credentials: LLMCredentials | None
    warnings: list[str] = field(default_factory=list)
    supports_tools: bool | None = None


def emit_preflight_warnings(sink: EventSink, preflight: TurnPreflightResult) -> None:
    """Push soft-gate hints onto the SSE stream before the pipeline task starts."""
    for warning in preflight.warnings:
        sink.emit(turn_warning(warning))


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


async def _tools_support_warnings(
    session: AsyncSession, user_id: str, *, needs_tools: bool
) -> list[str]:
    """Soft gate hint when probe marked the user's model as lacking tool calling."""
    if not needs_tools:
        return []
    row = await UserLlmKeyRepository(session).get_by_user_id(user_id)
    if row is not None and row.supports_tools is False:
        return [TOOLS_SOFT_GATE_WARNING]
    return []


async def _preflight_turn_llm(
    *,
    session: AsyncSession,
    user: User,
    cost_repo: CostEventRepository,
    needs_tools: bool = False,
) -> TurnPreflightResult:
    """Pre-turn billing gate, run before the SSE opens so a refused turn gets a
    clean error instead of a half-opened stream.

    BYOK mode: require the user's own API key and return the resolved credentials
    to thread through the turn — refuse with ``BYOKKeyMissingError`` (→ 402
    LLM_KEY_REQUIRED) when none is configured. Platform mode: keep the quota 防线
    and return ``None`` (the turn runs on the global server key). Resolving here
    and threading the result down means "preflight passes" == "the turn runs on
    this key" — the runtime never re-resolves to a different decision.

    When ``needs_tools`` (delegate / debate turn) and probe recorded
    ``supports_tools=False``, a warning is returned — soft gate only, never a 400.
    """
    warnings = await _tools_support_warnings(session, user.user_id, needs_tools=needs_tools)
    row = await UserLlmKeyRepository(session).get_by_user_id(user.user_id)
    supports_tools = row.supports_tools if row is not None else None
    credentials = await preflight_llm_credentials(
        session=session,
        user=user,
        cost_repo=cost_repo,
        byok_missing_message="请先在「设置 · 模型配置」中填入你的 API Key，再发起对话。",
    )
    return TurnPreflightResult(
        credentials=credentials, warnings=warnings, supports_tools=supports_tools
    )


async def release_request_db_before_sse(session: AsyncSession) -> None:
    """Return the request-scoped session before a long-lived ``StreamingResponse``.

    Chat-turn SSE routes inject ``Depends(get_db)`` for preflight (ownership +
    billing) so they share the same schema / override path as every other route.
    FastAPI would otherwise keep that session open until the stream finishes,
    pinning a pooled connection for the whole turn — callers must close explicitly
    after preflight, before ``sse_response``.
    """
    await session.close()


async def _preflight_owned_chat_turn(
    conversation_id: str,
    user: User,
    session: AsyncSession,
    *,
    needs_tools: bool = False,
) -> TurnPreflightResult:
    """Owner check + billing gate on the request-scoped session (SSE preflight only).

    Callers must invoke :func:`release_request_db_before_sse` after this returns and
    before opening the SSE stream so the pooled connection is not held for minutes.
    """
    conv_repo = ConversationRepository(session)
    cost_repo = CostEventRepository(session)
    await _require_owned_conversation(conversation_id, user.user_id, conv_repo)
    return await _preflight_turn_llm(
        session=session,
        user=user,
        cost_repo=cost_repo,
        needs_tools=needs_tools,
    )
