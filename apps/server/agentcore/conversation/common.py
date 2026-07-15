"""Shared helpers for conversation turn orchestration."""

from __future__ import annotations

import asyncio
import contextlib

from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.core.logging import get_logger
from agentcore.core.text import clip_preview
from agentcore.db.base import async_session_factory
from agentcore.db.models import Conversation
from agentcore.db.repositories import ConversationRepository, UserRepository
from agentcore.llm.credentials import LLMCredentials
from agentcore.llm.factory import build_provider
from agentcore.llm.profiles import TurnProfiles, default_turn_profiles
from agentcore.llm.provider.protocol import LLMProvider
from agentcore.llm.resolve import resolve_credentials, resolve_turn_model
from agentcore.memory import (
    TITLE_MAX_CHARS,
    ChatMessage,
    FollowupInput,
    LLMFollowupsGenerator,
    LLMTitleGenerator,
    TitleInput,
    TitleResult,
)
from agentcore.runtime.events import EventSink, title_generated
from agentcore.workspace.locate import LocalBinding

logger = get_logger(__name__)

# Fire-and-forget early title mint (cloud SSE). In-process like schedule_compaction:
# ``_inflight`` dedupes a burst; ``_tasks`` holds refs so a pass is not GC'd mid-flight.
_title_inflight: set[str] = set()
_title_tasks: set[asyncio.Task] = set()


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


# Turn-log message previews: enough of the user prompt / assistant reply to triage
# 「问了什么 / 答得如何」straight from a log line (no DB round-trip), while staying a
# bounded snippet — never the full 正文 (logging.mdc 铁律). ~200 chars ≈ a first paragraph.
LOG_PREVIEW_CHARS = 200


def preview(text: str, *, limit: int = LOG_PREVIEW_CHARS) -> str:
    """Single-line, length-capped preview of message text for a log field."""
    return clip_preview(text, limit)


async def resolve_local_binding(session: AsyncSession, conv: Conversation) -> LocalBinding | None:
    """Resolve a turn's local-mode binding (项目即工作区).

    - **Project chat** (``folder_id`` set): inherit the project's ``local_root_id`` /
      ``local_subpath``. Cloud projects (both NULL) → ``None``.
    - **裸聊**: ``local_root_id`` (explicit) or ``local_container_root_id`` (desktop
      local-first intent). Empty ``local_subpath`` resolves to
      ``conversations/<conversation_id>`` under the container (per-对话隔离；懒建).
      Cloud SSE turns honor both so sidecar-written files stay visible when the
      turn falls back from sidecar to cloud.
    """
    from agentcore.conversation.scratch import (
        bare_chat_local_subpath,
        resolve_conversation_local_binding,
    )
    from agentcore.db.repositories import FolderRepository

    if conv.folder_id:
        folder = await FolderRepository(session).get_by_id_unscoped(conv.folder_id)
        if not folder:
            return None
        return resolve_conversation_local_binding(
            local_root_id=folder.local_root_id,
            local_subpath=folder.local_subpath,
            label=folder.name or "workspace",
        )

    root_id = conv.local_root_id or conv.local_container_root_id
    subpath = conv.local_subpath or (bare_chat_local_subpath(conv.id) if root_id else None)
    return resolve_conversation_local_binding(
        local_root_id=root_id,
        local_subpath=subpath,
        label="workspace",
    )


async def generate_title(
    *,
    provider: LLMProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
    model: str | None = None,
) -> TitleResult:
    """Best-effort title via the fast model; falls back to truncation.

    ``LLMTitleGenerator`` already retries once on an empty model body (timeout
    does not retry). An empty result after that — or any call-level error —
    degrades to ``fallback_title`` (first user message, ≤30 chars).
    """
    fallback = fallback_title(user_message)
    if not user_message.strip():
        return TitleResult(title=fallback)

    messages: list[ChatMessage] = [{"role": "user", "content": user_message}]
    if assistant_reply.strip():
        messages.append({"role": "assistant", "content": assistant_reply})

    try:
        result = await LLMTitleGenerator(provider, model=model).generate(
            TitleInput(conversation_id=conversation_id, messages=messages)
        )
        title = result.title or fallback
        return TitleResult(title=title)
    except Exception as e:
        logger.warning("chat.title_failed", conversation_id=conversation_id, error=str(e))
        return TitleResult(title=fallback)


async def _mint_title_background(
    *,
    conversation_id: str,
    user_id: str,
    user_message: str,
    sink: EventSink,
) -> None:
    """Cloud early-title runner: user-message-only LLM mint → conditional write → SSE.

    Never raises. Skips when the conversation already has a title (user rename race).
    Emit is best-effort — a closed sink (short-lived / failed turn) must not undo a
    successful DB write.
    """
    try:
        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
            if conv is None or (conv.title and str(conv.title).strip()):
                return

        async with async_session_factory() as session:
            credentials = await resolve_credentials(session, user_id, "platform_internal")
        model = resolve_turn_model(credentials)
        provider = build_provider(credentials, purpose="platform_internal")
        try:
            # Cloud early path: first user message only — do not wait for assistant reply.
            minted = await generate_title(
                provider=provider,
                conversation_id=conversation_id,
                user_message=user_message,
                assistant_reply="",
                model=model,
            )
        finally:
            await provider.close()

        if not minted.title:
            return

        async with async_session_factory() as session:
            updated = await ConversationRepository(session).update_title_if_empty(
                conversation_id, minted.title
            )
        if updated is None:
            return

        with contextlib.suppress(Exception):
            sink.emit(title_generated(minted.title, conversation_id=conversation_id))
    except Exception as e:
        logger.warning(
            "chat.title_schedule_failed",
            conversation_id=conversation_id,
            error=str(e),
        )
    finally:
        _title_inflight.discard(conversation_id)


def schedule_title_generation(
    *,
    conversation_id: str,
    user_id: str,
    user_message: str,
    sink: EventSink,
) -> None:
    """Fire-and-forget early title mint for a cloud SSE turn (sync schedule only).

    Call after the first user message is persisted (``turn_saved``), in parallel with
    the turn pipeline. No-op when a mint for this conversation is already in flight.
    """
    if conversation_id in _title_inflight:
        return
    _title_inflight.add(conversation_id)
    task = asyncio.ensure_future(
        _mint_title_background(
            conversation_id=conversation_id,
            user_id=user_id,
            user_message=user_message,
            sink=sink,
        )
    )
    _title_tasks.add(task)
    task.add_done_callback(_title_tasks.discard)


async def generate_followups(
    *,
    provider: LLMProvider,
    conversation_id: str,
    user_message: str,
    assistant_reply: str,
    model: str | None = None,
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
        return await LLMFollowupsGenerator(provider, model=model).generate(
            FollowupInput(conversation_id=conversation_id, messages=messages)
        )
    except Exception as e:
        logger.warning("chat.followups_failed", conversation_id=conversation_id, error=str(e))
        return []


async def resolve_turn_profiles(
    session: AsyncSession,
    conv: Conversation,
    user_id: str,
    credentials: LLMCredentials | None = None,
) -> TurnProfiles:
    """Resolve model + static profiles for this turn."""
    if credentials is None:
        credentials = await resolve_credentials(session, user_id, "user_facing")
    return default_turn_profiles(model=resolve_turn_model(credentials))


# Legacy name used by conversation service exports.
resolve_profile_set = resolve_turn_profiles


async def resolve_memory_enabled(session: AsyncSession, user_id: str) -> bool:
    """This turn's long-term-memory master switch (Agent记忆与知识系统 §一).

    Defaults to True for an unknown user (memory on, the product default), so a
    missing row never silently suppresses injection.
    """
    user = await UserRepository(session).get_by_id(user_id)
    return user.memory_enabled if user else True


async def resolve_autonomy_policy(session: AsyncSession, user_id: str):
    """User-global *default* AutonomyPolicy (seeds new conversations only).

    Runtime gates must use :func:`resolve_permission_preset` / the conversation
    column — not this. Kept for settings API and create-time seeding.
    """
    from agentcore.core.types import AutonomyPolicy

    user = await UserRepository(session).get_by_id(user_id)
    raw = (user.autonomy_policy if user else None) or AutonomyPolicy.FIRST_GRANT.value
    try:
        return AutonomyPolicy(raw)
    except ValueError:
        return AutonomyPolicy.FIRST_GRANT


def parse_permission_preset(raw: str | None):
    """Coerce a stored / wire permission_preset string; unknown → workspace."""
    from agentcore.core.types import PermissionPreset

    try:
        return PermissionPreset(raw or PermissionPreset.WORKSPACE.value)
    except ValueError:
        return PermissionPreset.WORKSPACE


async def resolve_permission_preset(session: AsyncSession, conversation_id: str):
    """This turn's permission mode — conversation column is the single source of truth."""
    from agentcore.db.repositories import ConversationRepository

    conv = await ConversationRepository(session).get_by_id_unscoped(conversation_id)
    return parse_permission_preset(conv.permission_preset if conv else None)


async def default_permission_preset_for_user(session: AsyncSession, user_id: str):
    """Map the user's autonomy preference → PermissionPreset for a new conversation."""
    from agentcore.core.types import autonomy_to_preset

    return autonomy_to_preset(await resolve_autonomy_policy(session, user_id))
