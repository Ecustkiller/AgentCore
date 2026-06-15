"""FastAPI dependencies (DB session, repositories, current user)."""

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Cookie, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.auth import AuthService
from agentcore.core.errors import AuthenticationError, AuthorizationError
from agentcore.db.base import get_session
from agentcore.db.models import User
from agentcore.db.repositories import (
    ChatRepository,
    ConversationRepository,
    CostEventRepository,
    CredentialsRepository,
    FolderRepository,
    HandoffJobRepository,
    InviteRepository,
    MessageRepository,
    ModelModeRepository,
    RefreshTokenRepository,
    UserBlockRepository,
    UserDirectoryRepository,
    UserRepository,
)
from agentcore.messaging import MessagingService
from agentcore.messaging.hub import HubChatEventPublisher, default_chat_hub
from agentcore.security import decode_access_token

# Cookie name carrying the access JWT (set by the auth routes).
ACCESS_TOKEN_COOKIE = "access_token"


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session."""
    async for session in get_session():
        yield session


def get_user_repo(session: AsyncSession = Depends(get_db)) -> UserRepository:
    return UserRepository(session)


def get_conversation_repo(session: AsyncSession = Depends(get_db)) -> ConversationRepository:
    return ConversationRepository(session)


def get_folder_repo(session: AsyncSession = Depends(get_db)) -> FolderRepository:
    return FolderRepository(session)


def get_model_mode_repo(session: AsyncSession = Depends(get_db)) -> ModelModeRepository:
    return ModelModeRepository(session)


def get_message_repo(session: AsyncSession = Depends(get_db)) -> MessageRepository:
    return MessageRepository(session)


def get_cost_event_repo(session: AsyncSession = Depends(get_db)) -> CostEventRepository:
    return CostEventRepository(session)


def get_handoff_job_repo(session: AsyncSession = Depends(get_db)) -> HandoffJobRepository:
    return HandoffJobRepository(session)


def get_messaging_service(
    session: AsyncSession = Depends(get_db),
) -> MessagingService:
    """Build MessagingService (消息页 找人 IM) with its four repos on one session.

    The realtime publisher fans a persisted message out to recipients' SSE
    firehoses through the process-wide in-process hub (消息IM.md §四); swap it
    for a Redis / NATS publisher behind the ``ChatEventPublisher`` seam to scale
    past one worker.
    """
    return MessagingService(
        users=UserRepository(session),
        chats=ChatRepository(session),
        blocks=UserBlockRepository(session),
        directory=UserDirectoryRepository(session),
        events=HubChatEventPublisher(default_chat_hub()),
    )


def get_auth_service(session: AsyncSession = Depends(get_db)) -> AuthService:
    """Build AuthService with all four repos bound to one request session."""
    return AuthService(
        users=UserRepository(session),
        credentials=CredentialsRepository(session),
        refresh_tokens=RefreshTokenRepository(session),
        invites=InviteRepository(session),
    )


async def get_current_user(
    access_token: Annotated[str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)] = None,
    user_repo: UserRepository = Depends(get_user_repo),
) -> User:
    """Resolve the authenticated user from the access-token cookie (401 if absent/invalid)."""
    if not access_token:
        raise AuthenticationError("Not authenticated")
    user_id = decode_access_token(access_token)
    user = await user_repo.get_by_id(user_id)
    if user is None or user.status != "active":
        raise AuthenticationError("User not found or inactive")
    return user


async def get_optional_user(
    access_token: Annotated[str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)] = None,
    user_repo: UserRepository = Depends(get_user_repo),
) -> User | None:
    """Like get_current_user but returns None instead of raising when unauthenticated."""
    if not access_token:
        return None
    try:
        user_id = decode_access_token(access_token)
    except AuthenticationError:
        return None
    user = await user_repo.get_by_id(user_id)
    if user is None or user.status != "active":
        return None
    return user


AuthUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]


async def get_current_admin(user: AuthUser) -> User:
    """Resolve the current user and require the admin role (403 otherwise)."""
    if user.role != "admin":
        raise AuthorizationError("Admin privileges required")
    return user


AdminUser = Annotated[User, Depends(get_current_admin)]
