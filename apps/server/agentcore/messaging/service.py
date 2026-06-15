"""Messaging service: the 消息 page (找人 IM) business logic (消息IM.md).

Holds all IM policy so the HTTP layer stays thin and the repos do pure data
access:
- 任意搜人 visibility: exact-match search, minus self, blocked pairs, and users
  who opted out of discovery (``user_directory_settings.discoverable``);
- who-can-DM gate: opening a *new* dm with someone set to ``contacts`` is refused
  (no contact graph in P0 → effectively a hard opt-out), while the default
  ``anyone`` lets a stranger through as a *message request* (peer starts pending);
- send-message guards: must be a chat member (else 404, IDOR-safe), dm blocked
  pairs are refused, and a reply by the requested party clears their pending gate;
- list / unread / read-cursor / block / directory-settings management.

The service depends on repository instances (unit-testable with in-memory fakes)
and an optional realtime publisher (a seam — see ``events.py``) it calls to fan a
new message out to every member's live connections.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from agentcore.core.errors import (
    AuthorizationError,
    NotFoundError,
    ValidationError,
)
from agentcore.core.logging import get_logger
from agentcore.db.models import Chat, ChatMember, ChatMessage, User
from agentcore.db.repositories import (
    ChatRepository,
    UserBlockRepository,
    UserDirectoryRepository,
    UserRepository,
)
from agentcore.messaging.events import ChatEventPublisher, NullChatEventPublisher

logger = get_logger(__name__)

_MAX_PAGE_SIZE = 100
_DEFAULT_PAGE_SIZE = 50


@dataclass(frozen=True)
class ChatView:
    """A chat plus the viewer's per-chat state and resolved dm peer — the domain
    shape the route maps to ``ChatSummary`` (schema conversion stays in the route).
    """

    chat: Chat
    member: ChatMember
    peer: User | None
    unread: int


@dataclass(frozen=True)
class DirectoryView:
    """A user's resolved discoverability + who-can-DM (defaults applied)."""

    discoverable: bool
    who_can_dm: str


@dataclass(frozen=True)
class MessagePage:
    """A page of chat messages with paging echoed back for the list response."""

    messages: Sequence[ChatMessage]
    total: int
    page: int
    page_size: int


class MessagingService:
    def __init__(
        self,
        *,
        users: UserRepository,
        chats: ChatRepository,
        blocks: UserBlockRepository,
        directory: UserDirectoryRepository,
        events: ChatEventPublisher | None = None,
    ) -> None:
        self._users = users
        self._chats = chats
        self._blocks = blocks
        self._directory = directory
        self._events: ChatEventPublisher = events or NullChatEventPublisher()

    # --- People search (任意搜人 + 护栏) ---

    async def search_users(
        self, *, requester_id: str, query: str, limit: int = 20
    ) -> list[User]:
        """Exact-match people-search, filtered by visibility rules.

        Drops the requester themselves, any user in a block relationship with
        them (either direction), and anyone who turned discovery off. A missing
        directory row means discoverable (open search is the product default).
        """
        candidates = await self._users.search(query, limit=limit)
        visible: list[User] = []
        for user in candidates:
            if user.user_id == requester_id:
                continue
            if await self._blocks.is_blocked_between(requester_id, user.user_id):
                continue
            settings = await self._directory.get(user.user_id)
            if settings is not None and not settings.discoverable:
                continue
            visible.append(user)
        return visible

    # --- Chats ---

    async def start_dm(self, *, requester_id: str, peer_id: str) -> ChatView:
        """Open (or reuse) a 1:1 chat with another user.

        Reuses the existing dm if there is one (idempotent open). For a brand-new
        dm: refuses self-dm, unknown/disabled peers, blocked pairs, and peers set
        to ``who_can_dm = contacts``. The peer joins ``pending`` (message request)
        until they reply.
        """
        if peer_id == requester_id:
            raise ValidationError("不能与自己发起会话")
        peer = await self._users.get_by_id(peer_id)
        if peer is None or peer.status != "active":
            raise NotFoundError("用户不存在")
        if await self._blocks.is_blocked_between(requester_id, peer_id):
            raise AuthorizationError("无法向该用户发送消息")

        existing = await self._chats.get_dm(requester_id, peer_id)
        if existing is not None:
            member = await self._chats.get_member(existing.id, requester_id)
            assert member is not None  # creator is always a member of their dm
            return ChatView(chat=existing, member=member, peer=peer, unread=0)

        settings = await self._directory.get(peer_id)
        if settings is not None and settings.who_can_dm == "contacts":
            raise AuthorizationError("对方仅允许联系人发起会话")

        chat = await self._chats.create_dm(creator_id=requester_id, peer_id=peer_id)
        member = await self._chats.get_member(chat.id, requester_id)
        assert member is not None
        logger.debug("dm.opened", chat=chat.id, by=requester_id, peer=peer_id)
        return ChatView(chat=chat, member=member, peer=peer, unread=0)

    async def list_chats(self, *, user_id: str) -> list[ChatView]:
        """The user's chat list (recent first), with unread counts and dm peers
        resolved in batch (no N+1).
        """
        memberships = await self._chats.list_memberships(user_id)
        chat_ids = [chat.id for chat, _ in memberships]
        unread = await self._chats.unread_counts(user_id)
        peer_ids = await self._chats.peer_ids_for(chat_ids, exclude_user_id=user_id)
        peers = await self._users.get_by_ids(list(peer_ids.values()))

        views: list[ChatView] = []
        for chat, member in memberships:
            peer_id = peer_ids.get(chat.id)
            peer = peers.get(peer_id) if peer_id else None
            views.append(
                ChatView(
                    chat=chat,
                    member=member,
                    peer=peer,
                    unread=unread.get(chat.id, 0),
                )
            )
        return views

    # --- Messages ---

    async def send_message(
        self,
        *,
        chat_id: str,
        sender_id: str,
        content: str,
        content_type: str = "text",
        attachments: list | None = None,
        reply_to_message_id: str | None = None,
        client_msg_id: str | None = None,
    ) -> ChatMessage:
        """Send a message into a chat the user belongs to.

        Non-members get 404 (IDOR-safe — no existence leak). In a dm, a block in
        either direction refuses the send. A reply by the party who was holding a
        pending message-request accepts it. The stored message is fanned out to
        every member's live connections (sender included, for multi-device).
        """
        member = await self._chats.get_member(chat_id, sender_id)
        if member is None:
            raise NotFoundError("会话不存在")
        chat = await self._chats.get_chat(chat_id)
        if chat is None:
            raise NotFoundError("会话不存在")

        if chat.type == "dm":
            peer_ids = await self._chats.peer_ids_for(
                [chat_id], exclude_user_id=sender_id
            )
            peer_id = peer_ids.get(chat_id)
            if peer_id and await self._blocks.is_blocked_between(sender_id, peer_id):
                raise AuthorizationError("无法向该用户发送消息")

        message = await self._chats.add_message(
            chat_id=chat_id,
            sender_user_id=sender_id,
            content=content,
            content_type=content_type,
            attachments=attachments,
            reply_to_message_id=reply_to_message_id,
            client_msg_id=client_msg_id,
        )

        if member.state == "pending":
            await self._chats.accept_request(chat_id, sender_id)

        members = await self._chats.list_members(chat_id)
        await self._events.publish(
            [m.user_id for m in members], self._message_event(message)
        )
        return message

    async def list_messages(
        self,
        *,
        chat_id: str,
        user_id: str,
        page: int = 1,
        page_size: int = _DEFAULT_PAGE_SIZE,
    ) -> MessagePage:
        """A page of a chat's messages (oldest first). Non-members get 404."""
        if await self._chats.get_member(chat_id, user_id) is None:
            raise NotFoundError("会话不存在")
        page = max(1, page)
        page_size = max(1, min(page_size, _MAX_PAGE_SIZE))
        offset = (page - 1) * page_size
        messages, total = await self._chats.list_messages(
            chat_id, limit=page_size, offset=offset
        )
        return MessagePage(
            messages=messages, total=total, page=page, page_size=page_size
        )

    async def mark_read(
        self, *, chat_id: str, user_id: str, last_read_message_id: str
    ) -> None:
        """Advance the user's read cursor (drives unread counts). Non-members 404."""
        if await self._chats.get_member(chat_id, user_id) is None:
            raise NotFoundError("会话不存在")
        await self._chats.mark_read(
            chat_id, user_id, last_read_message_id=last_read_message_id
        )

    # --- Blocking (任意搜人 护栏) ---

    async def block_user(self, *, user_id: str, target_id: str) -> None:
        if target_id == user_id:
            raise ValidationError("不能拉黑自己")
        target = await self._users.get_by_id(target_id)
        if target is None:
            raise NotFoundError("用户不存在")
        await self._blocks.block(user_id, target_id)
        logger.info("dm.user_blocked", user=user_id, target=target_id)

    async def unblock_user(self, *, user_id: str, target_id: str) -> None:
        await self._blocks.unblock(user_id, target_id)

    async def list_blocked(self, *, user_id: str) -> list[User]:
        blocked_ids = await self._blocks.list_blocked(user_id)
        users = await self._users.get_by_ids(blocked_ids)
        return [users[uid] for uid in blocked_ids if uid in users]

    # --- Directory settings (discoverability + who-can-DM) ---

    async def get_directory_settings(self, *, user_id: str) -> DirectoryView:
        settings = await self._directory.get(user_id)
        if settings is None:
            return DirectoryView(discoverable=True, who_can_dm="anyone")
        return DirectoryView(
            discoverable=settings.discoverable, who_can_dm=settings.who_can_dm
        )

    async def update_directory_settings(
        self,
        *,
        user_id: str,
        discoverable: bool | None = None,
        who_can_dm: str | None = None,
    ) -> DirectoryView:
        """Patch the user's privacy settings; ``None`` leaves a field unchanged."""
        changes: dict[str, Any] = {}
        if discoverable is not None:
            changes["discoverable"] = discoverable
        if who_can_dm is not None:
            changes["who_can_dm"] = who_can_dm
        settings = await self._directory.upsert(user_id, **changes)
        return DirectoryView(
            discoverable=settings.discoverable, who_can_dm=settings.who_can_dm
        )

    # --- Realtime event payloads ---

    @staticmethod
    def _message_event(message: ChatMessage) -> dict[str, Any]:
        """The ``chat_message`` realtime event (mirrors ``ChatMessageDetail``)."""
        return {
            "type": "chat_message",
            "chat_id": message.chat_id,
            "message": {
                "id": message.id,
                "chat_id": message.chat_id,
                "sender_user_id": message.sender_user_id,
                "sender_type": message.sender_type,
                "content": message.content,
                "content_type": message.content_type,
                "attachments": message.attachments or [],
                "payload": message.payload,
                "reply_to_message_id": message.reply_to_message_id,
                "created_at": (
                    message.created_at.isoformat() if message.created_at else None
                ),
            },
        }
