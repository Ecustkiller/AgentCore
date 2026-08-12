"""Bare-chat auto cloud-desk naming + Conversation.auto_desk_folder_id I/O."""

from __future__ import annotations

from typing import Any, Literal, NamedTuple

from agentcore.core.logging import get_logger
from agentcore.runtime.delegate.target_desktop_gate import gate_bare_chat_requires_target

logger = get_logger(__name__)

_AUTO_CLOUD_DESK_NAME_MAX = 200
_DEFAULT_AUTO_CLOUD_DESK_NAME = "云项目"


class AutoDeskPersistResult(NamedTuple):
    """Outcome of persisting a just-minted auto cloud desk pointer.

    ``won`` — this call wrote ``effective_id`` (always the minted id).
    ``lost`` — another turn won; ``effective_id`` is the winner's desk (reclaim mint).
    ``failed`` — DB/IO error; ``effective_id`` is the minted id for *this turn only*
    (product: do not block the turn). Distinct from ``lost`` so callers never treat
    failure as a race win/loss or silently conflate it with a missing conversation.
    Next-turn remint after ``failed`` is an accepted rare edge (no sweeper); the
    failure itself is never collapsed into a bare ``None``.
    """

    effective_id: str | None
    outcome: Literal["won", "lost", "failed"]


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
) -> AutoDeskPersistResult:
    """Write ``auto_desk_folder_id`` once; never touches birth ``folder_id``.

    See :class:`AutoDeskPersistResult` for won / lost / failed semantics. Exceptions
    are caught so persist failure does not block this turn's desk, but the outcome
    is ``failed`` (not a silent ``None``) so callers can distinguish it from a race.
    """
    cleaned = folder_id.strip() if isinstance(folder_id, str) else ""
    if not conversation_id or not user_id or not cleaned:
        return AutoDeskPersistResult(None, "failed")
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            effective, won = await ConversationRepository(session).set_auto_desk_folder_id(
                conversation_id, cleaned, user_id=user_id
            )
        if won:
            return AutoDeskPersistResult(cleaned, "won")
        if effective is not None:
            return AutoDeskPersistResult(effective, "lost")
        # Conversation missing / not owned — treat like failed (use mint this turn).
        return AutoDeskPersistResult(cleaned, "failed")
    except Exception:  # noqa: BLE001 — persist failure must not block this turn's desk
        logger.warning(
            "delegate.auto_desk_folder_id_persist_failed",
            conversation_id=conversation_id,
            folder_id=cleaned,
            exc_info=True,
        )
        return AutoDeskPersistResult(cleaned, "failed")


async def clear_stale_auto_desk_folder_id(
    *,
    user_id: str,
    conversation_id: str | None,
    folder_id: str,
) -> bool:
    """Clear a dead auto-desk pointer (folder missing / soft-deleted) for remint."""
    cleaned = folder_id.strip() if isinstance(folder_id, str) else ""
    if not conversation_id or not user_id or not cleaned:
        return False
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import ConversationRepository

        async with async_session_factory() as session:
            cleared = await ConversationRepository(session).clear_auto_desk_folder_id(
                conversation_id,
                user_id=user_id,
                expected_folder_id=cleaned,
            )
        if cleared:
            logger.info(
                "delegate.auto_desk_pointer_cleared",
                conversation_id=conversation_id,
                folder_id=cleaned,
            )
        return cleared
    except Exception:  # noqa: BLE001 — heal is best-effort; bind already failed
        logger.warning(
            "delegate.auto_desk_pointer_clear_failed",
            conversation_id=conversation_id,
            folder_id=cleaned,
            exc_info=True,
        )
        return False


async def reclaim_orphan_auto_desk_folder(
    *,
    user_id: str,
    folder_id: str,
) -> None:
    """Soft-delete a Folder minted by a race loser (best-effort, no sweeper)."""
    cleaned = folder_id.strip() if isinstance(folder_id, str) else ""
    if not user_id or not cleaned:
        return
    try:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories import FolderRepository

        async with async_session_factory() as session:
            deleted = await FolderRepository(session).soft_delete(cleaned, user_id=user_id)
        if deleted:
            logger.info(
                "delegate.auto_desk_orphan_reclaimed",
                folder_id=cleaned,
                user_id=user_id,
            )
        else:
            logger.warning(
                "delegate.auto_desk_orphan_reclaim_missed",
                folder_id=cleaned,
                user_id=user_id,
            )
    except Exception:  # noqa: BLE001 — orphan reclaim must not break the winning desk path
        logger.warning(
            "delegate.auto_desk_orphan_reclaim_failed",
            folder_id=cleaned,
            user_id=user_id,
            exc_info=True,
        )
