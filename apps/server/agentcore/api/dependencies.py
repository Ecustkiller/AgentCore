"""FastAPI dependencies (DB session, repositories, current user)."""

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Cookie, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.auth import AuthService
from agentcore.core.errors import AuthenticationError
from agentcore.db.base import get_session
from agentcore.db.models import User
from agentcore.db.repositories import (
    ConversationRepository,
    CredentialsRepository,
    InviteRepository,
    MessageRepository,
    RefreshTokenRepository,
    UserRepository,
)
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


def get_message_repo(session: AsyncSession = Depends(get_db)) -> MessageRepository:
    return MessageRepository(session)


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
