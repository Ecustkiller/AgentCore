"""Bare-chat auto cloud-desk naming + Conversation.auto_desk_folder_id I/O."""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.runtime.delegate.target_desktop_gate import gate_bare_chat_requires_target

logger = get_logger(__name__)

_AUTO_CLOUD_DESK_NAME_MAX = 200
_DEFAULT_AUTO_CLOUD_DESK_NAME = "云项目"


def auto_cloud_desk_name(
    *,
    conversation_title: str | None,
    user_message: str | None,
) -> str:
    title = (conversation_title or "").strip()
    if title:
        return title[:_AUTO_CLOUD_DESK_NAME_MAX]
    preview = " ".join((user_message or "").split()).strip()
    if preview:
        return preview[:_AUTO_CLOUD_DESK_NAME_MAX]
    return _DEFAULT_AUTO_CLOUD_DESK_NAME


async def load_conversation_title(
    *,
    user_id: str,
    conversation_id: str | None,
) -> str | None:
    if not conversation_id or not user_id:
        return None
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id, user_id=user_id)
        if conv is None:
            return None
        title = getattr(conv, "title", None)
        if isinstance(title, str) and title.strip():
            return title.strip()
    except Exception:  # noqa: BLE001 — title is best-effort for naming only
        logger.debug(
            "delegate.auto_cloud_desk_title_lookup_failed",
            conversation_id=conversation_id,
            exc_info=True,
        )
    return None


def bare_chat_write_tasks_need_target(
    *,
    session_folder_id: str | None,
    tasks_raw: list[dict[str, Any]],
    default_target_folder_id: str | None,
) -> bool:
    """True when gate would reject (no birth + write desk lacking effective target)."""
    return (
        gate_bare_chat_requires_target(
            session_folder_id=session_folder_id,
            tasks_raw=tasks_raw,
            default_target_folder_id=default_target_folder_id,
        )
        is not None
    )


async def load_auto_desk_folder_id(
    *,
    user_id: str,
    conversation_id: str | None,
) -> str | None:
    """Owner-scoped read of ``Conversation.auto_desk_folder_id`` (best-effort)."""
    if not conversation_id or not user_id:
        return None
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            conv = await ConversationRepository(session).get_by_id(conversation_id, user_id=user_id)
        if conv is None:
            return None
        raw = getattr(conv, "auto_desk_folder_id", None)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    except Exception:  # noqa: BLE001 — reuse is best-effort; fall through to create
        logger.debug(
            "delegate.auto_desk_folder_id_lookup_failed",
            conversation_id=conversation_id,
            exc_info=True,
        )
    return None


async def persist_auto_desk_folder_id(
    *,
    user_id: str,
    conversation_id: str | None,
    folder_id: str,
) -> str | None:
    """Write ``auto_desk_folder_id`` once; never touches birth ``folder_id``."""
    if not conversation_id or not user_id:
        return None
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            return await ConversationRepository(session).set_auto_desk_folder_id(
                conversation_id, folder_id, user_id=user_id
            )
    except Exception:  # noqa: BLE001 — persist failure must not block this turn's desk
        logger.warning(
            "delegate.auto_desk_folder_id_persist_failed",
            conversation_id=conversation_id,
            folder_id=folder_id,
            exc_info=True,
        )
        return None
