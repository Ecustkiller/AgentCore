"""FastAPI dependencies (DB session, repositories, current user)."""

from collections.abc import AsyncGenerator
from typing import Annotated

from fastapi import Cookie, Depends, Header
from sqlalchemy.ext.asyncio import AsyncSession

from agentcore.admin import AdminService
from agentcore.auth import AuthService
from agentcore.core.errors import AuthenticationError, AuthorizationError
from agentcore.db.base import get_session
from agentcore.db.models import User
from agentcore.db.repositories import (
    AdminAuditRepository,
    ChatRepository,
    ConversationRepository,
    ConversationShareRepository,
    CostEventRepository,
    CredentialsRepository,
    FolderRepository,
    HandoffJobRepository,
    InviteRepository,
    MessageRepository,
    ModelModeRepository,
    PushDeviceRepository,
    RefreshTokenRepository,
    TurnJournalRepository,
    TurnMetricsRepository,
    UserBlockRepository,
    UserDirectoryRepository,
    UserLlmKeyRepository,
    UserRepository,
)
from agentcore.messaging import MessagingService
from agentcore.messaging.hub import HubChatEventPublisher, default_chat_hub
from agentcore.security import decode_access_token
from agentcore.storage.assets import AssetStorage, build_asset_storage

# Cookie name carrying the access JWT (set by the auth routes).
ACCESS_TOKEN_COOKIE = "access_token"


def _bearer_token(authorization: str | None) -> str | None:
    """Extract the JWT from an ``Authorization: Bearer <token>`` header.

    The bearer path serves non-cookie clients (mobile web / Capacitor shell, M2):
    their origin can't rely on SameSite cookies, so they send the access token as a
    Bearer header instead. Returns None when the header is absent or not the Bearer
    scheme, so the caller falls back to the cookie (desktop) or to a 401.
    """
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async database session."""
    async for session in get_session():
        yield session


def get_user_repo(session: AsyncSession = Depends(get_db)) -> UserRepository:
    return UserRepository(session)


def get_admin_service(session: AsyncSession = Depends(get_db)) -> AdminService:
    """Build the admin account-management service (用户管理) on the request session."""
    return AdminService(users=UserRepository(session))


def get_admin_audit_repo(session: AsyncSession = Depends(get_db)) -> AdminAuditRepository:
    return AdminAuditRepository(session)


def get_conversation_repo(session: AsyncSession = Depends(get_db)) -> ConversationRepository:
    return ConversationRepository(session)


def get_conversation_share_repo(
    session: AsyncSession = Depends(get_db),
) -> ConversationShareRepository:
    return ConversationShareRepository(session)


def get_user_llm_key_repo(
    session: AsyncSession = Depends(get_db),
) -> UserLlmKeyRepository:
    return UserLlmKeyRepository(session)


def get_asset_storage() -> AssetStorage:
    """The process-wide asset store (头像等小对象); filesystem in dev, S3 in prod."""
    return build_asset_storage()


def get_folder_repo(session: AsyncSession = Depends(get_db)) -> FolderRepository:
    return FolderRepository(session)


def get_model_mode_repo(session: AsyncSession = Depends(get_db)) -> ModelModeRepository:
    return ModelModeRepository(session)


def get_message_repo(session: AsyncSession = Depends(get_db)) -> MessageRepository:
    return MessageRepository(session)


def get_cost_event_repo(session: AsyncSession = Depends(get_db)) -> CostEventRepository:
    return CostEventRepository(session)


def get_turn_metrics_repo(
    session: AsyncSession = Depends(get_db),
) -> TurnMetricsRepository:
    return TurnMetricsRepository(session)


def get_turn_journal_repo(
    session: AsyncSession = Depends(get_db),
) -> TurnJournalRepository:
    return TurnJournalRepository(session)


def get_handoff_job_repo(session: AsyncSession = Depends(get_db)) -> HandoffJobRepository:
    return HandoffJobRepository(session)


def get_push_device_repo(
    session: AsyncSession = Depends(get_db),
) -> PushDeviceRepository:
    return PushDeviceRepository(session)


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


def get_credentials_repo(
    session: AsyncSession = Depends(get_db),
) -> CredentialsRepository:
    return CredentialsRepository(session)


async def get_current_user(
    access_token: Annotated[str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
    user_repo: UserRepository = Depends(get_user_repo),
) -> User:
    """Resolve the authenticated user from the access-token cookie (desktop) or an
    ``Authorization: Bearer`` header (mobile/web bearer clients); 401 if absent/invalid."""
    token = access_token or _bearer_token(authorization)
    if not token:
        raise AuthenticationError("Not authenticated")
    user_id = decode_access_token(token)
    user = await user_repo.get_by_id(user_id)
    if user is None or user.status != "active":
        raise AuthenticationError("User not found or inactive")
    return user


async def get_optional_user(
    access_token: Annotated[str | None, Cookie(alias=ACCESS_TOKEN_COOKIE)] = None,
    authorization: Annotated[str | None, Header()] = None,
    user_repo: UserRepository = Depends(get_user_repo),
) -> User | None:
    """Like get_current_user but returns None instead of raising when unauthenticated."""
    token = access_token or _bearer_token(authorization)
    if not token:
        return None
    try:
        user_id = decode_access_token(token)
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
