"""Unit tests for MessagingService using in-memory fake repositories (no DB).

Covers the 消息 page (找人 IM) policy: people-search visibility, the start-dm
gates (self / unknown / disabled / blocked / contacts-only), send-message member
+ block + message-request handling and idempotency, list/unread, read cursor,
blocking, and directory settings. Mirrors test_auth_service.py's fake-repo style.
"""

from datetime import UTC, datetime, timedelta

import pytest

from agentcore.core.errors import (
    AuthorizationError,
    NotFoundError,
    ValidationError,
)
from agentcore.core.types import new_id
from agentcore.messaging import MessagingService

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class FakeUsers:
    def __init__(self) -> None:
        self._by_id: dict = {}

    def add(self, username, *, status="active", display_name=None):
        from types import SimpleNamespace

        user = SimpleNamespace(
            user_id=new_id(),
            username=username,
            display_name=display_name or username,
            status=status,
        )
        self._by_id[user.user_id] = user
        return user

    async def get_by_id(self, user_id):
        return self._by_id.get(user_id)

    async def get_by_ids(self, user_ids):
        return {uid: self._by_id[uid] for uid in user_ids if uid in self._by_id}

    async def search(self, query, *, limit=20):
        q = query.strip().lower()
        if not q:
            return []
        hits = [
            u
            for u in self._by_id.values()
            if u.username.lower() == q and u.status == "active"
        ]
        return hits[:limit]


class FakeChats:
    """In-memory chats/members/messages with a counter-driven clock so message
    ordering is deterministic (real created_at could tie on fast inserts).
    """

    def __init__(self) -> None:
        self._chats: dict = {}
        self._members: list = []
        self._messages: list = []
        self._seq = 0

    def _now(self):
        self._seq += 1
        return _EPOCH + timedelta(seconds=self._seq)

    @staticmethod
    def dm_key(user_a, user_b):
        return ":".join(sorted([user_a, user_b]))

    async def get_dm(self, user_a, user_b):
        key = self.dm_key(user_a, user_b)
        return next((c for c in self._chats.values() if c.dm_key == key), None)

    async def create_dm(self, *, creator_id, peer_id, peer_state="pending"):
        from types import SimpleNamespace

        chat = SimpleNamespace(
            id=new_id(),
            type="dm",
            created_by=creator_id,
            dm_key=self.dm_key(creator_id, peer_id),
            title=None,
            avatar_url=None,
            last_message_at=None,
            last_message_preview=None,
        )
        self._chats[chat.id] = chat
        for uid, state in ((creator_id, "accepted"), (peer_id, peer_state)):
            self._members.append(
                SimpleNamespace(
                    chat_id=chat.id,
                    user_id=uid,
                    state=state,
                    pinned=False,
                    muted=False,
                    last_read_at=None,
                    last_read_message_id=None,
                )
            )
        return chat

    async def get_chat(self, chat_id):
        return self._chats.get(chat_id)

    async def get_member(self, chat_id, user_id):
        return next(
            (
                m
                for m in self._members
                if m.chat_id == chat_id and m.user_id == user_id
            ),
            None,
        )

    async def list_members(self, chat_id):
        return [m for m in self._members if m.chat_id == chat_id]

    async def list_memberships(self, user_id):
        rows = [
            (self._chats[m.chat_id], m)
            for m in self._members
            if m.user_id == user_id
        ]
        rows.sort(key=lambda cm: cm[0].last_message_at or _EPOCH, reverse=True)
        return rows

    async def peer_ids_for(self, chat_ids, *, exclude_user_id):
        out: dict = {}
        for m in self._members:
            if m.chat_id in chat_ids and m.user_id != exclude_user_id:
                out.setdefault(m.chat_id, m.user_id)
        return out

    async def add_message(
        self,
        *,
        chat_id,
        sender_user_id,
        content,
        sender_type="user",
        content_type="text",
        attachments=None,
        payload=None,
        reply_to_message_id=None,
        client_msg_id=None,
    ):
        from types import SimpleNamespace

        if client_msg_id is not None and sender_user_id is not None:
            existing = next(
                (
                    m
                    for m in self._messages
                    if m.chat_id == chat_id
                    and m.sender_user_id == sender_user_id
                    and m.client_msg_id == client_msg_id
                ),
                None,
            )
            if existing is not None:
                return existing
        msg = SimpleNamespace(
            id=new_id(),
            chat_id=chat_id,
            sender_user_id=sender_user_id,
            sender_type=sender_type,
            content=content,
            content_type=content_type,
            attachments=attachments or [],
            payload=payload,
            reply_to_message_id=reply_to_message_id,
            client_msg_id=client_msg_id,
            created_at=self._now(),
        )
        self._messages.append(msg)
        chat = self._chats[chat_id]
        chat.last_message_at = msg.created_at
        chat.last_message_preview = (content or "")[:200]
        return msg

    async def list_messages(self, chat_id, *, limit=50, offset=0):
        rows = sorted(
            (m for m in self._messages if m.chat_id == chat_id),
            key=lambda m: m.created_at,
        )
        return rows[offset : offset + limit], len(rows)

    async def mark_read(
        self, chat_id, user_id, *, last_read_message_id, last_read_at=None
    ):
        member = await self.get_member(chat_id, user_id)
        member.last_read_message_id = last_read_message_id
        member.last_read_at = last_read_at or self._now()

    async def accept_request(self, chat_id, user_id):
        member = await self.get_member(chat_id, user_id)
        member.state = "accepted"

    async def unread_counts(self, user_id):
        out: dict = {}
        my_chats = {m.chat_id: m for m in self._members if m.user_id == user_id}
        for msg in self._messages:
            member = my_chats.get(msg.chat_id)
            if member is None or msg.sender_user_id == user_id:
                continue
            if member.last_read_at is None or msg.created_at > member.last_read_at:
                out[msg.chat_id] = out.get(msg.chat_id, 0) + 1
        return out


class FakeBlocks:
    def __init__(self) -> None:
        self._pairs: set = set()

    async def is_blocked_between(self, user_a, user_b):
        return (user_a, user_b) in self._pairs or (user_b, user_a) in self._pairs

    async def block(self, user_id, blocked_user_id):
        self._pairs.add((user_id, blocked_user_id))

    async def unblock(self, user_id, blocked_user_id):
        self._pairs.discard((user_id, blocked_user_id))

    async def list_blocked(self, user_id):
        return [b for (a, b) in self._pairs if a == user_id]


class FakeDirectory:
    def __init__(self) -> None:
        self._by_user: dict = {}

    async def get(self, user_id):
        return self._by_user.get(user_id)

    async def upsert(self, user_id, *, discoverable=None, who_can_dm=None):
        from types import SimpleNamespace

        settings = self._by_user.get(user_id)
        if settings is None:
            settings = SimpleNamespace(
                user_id=user_id, discoverable=True, who_can_dm="anyone"
            )
            self._by_user[user_id] = settings
        if discoverable is not None:
            settings.discoverable = discoverable
        if who_can_dm is not None:
            settings.who_can_dm = who_can_dm
        return settings

    def set(self, user_id, *, discoverable=True, who_can_dm="anyone"):
        from types import SimpleNamespace

        self._by_user[user_id] = SimpleNamespace(
            user_id=user_id, discoverable=discoverable, who_can_dm=who_can_dm
        )


class FakeEvents:
    def __init__(self) -> None:
        self.published: list = []

    async def publish(self, user_ids, event):
        self.published.append((list(user_ids), event))


def _make():
    users = FakeUsers()
    chats = FakeChats()
    blocks = FakeBlocks()
    directory = FakeDirectory()
    events = FakeEvents()
    svc = MessagingService(
        users=users,
        chats=chats,
        blocks=blocks,
        directory=directory,
        events=events,
    )
    return svc, users, chats, blocks, directory, events


# --- search_users ---


async def test_search_returns_exact_match():
    svc, users, *_ = _make()
    alice = users.add("alice")
    users.add("bob")
    hits = await svc.search_users(requester_id=alice.user_id, query="bob")
    assert [u.username for u in hits] == ["bob"]


async def test_search_excludes_self():
    svc, users, *_ = _make()
    alice = users.add("alice")
    hits = await svc.search_users(requester_id=alice.user_id, query="alice")
    assert hits == []


async def test_search_excludes_blocked_pair():
    svc, users, _chats, blocks, *_ = _make()
    alice = users.add("alice")
    carol = users.add("carol")
    await blocks.block(alice.user_id, carol.user_id)
    assert await svc.search_users(requester_id=alice.user_id, query="carol") == []
    # symmetric: carol also cannot find alice
    assert await svc.search_users(requester_id=carol.user_id, query="alice") == []


async def test_search_excludes_undiscoverable():
    svc, users, _chats, _blocks, directory, _events = _make()
    alice = users.add("alice")
    carol = users.add("carol")
    directory.set(carol.user_id, discoverable=False)
    assert await svc.search_users(requester_id=alice.user_id, query="carol") == []


# --- start_dm ---


async def test_start_dm_creates_chat_peer_pending():
    svc, users, chats, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    view = await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)
    assert view.chat.type == "dm"
    assert view.peer.user_id == bob.user_id
    assert view.member.state == "accepted"
    peer_member = await chats.get_member(view.chat.id, bob.user_id)
    assert peer_member.state == "pending"


async def test_start_dm_reuses_existing():
    svc, users, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    first = await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)
    # the peer opening it from their side resolves to the same chat row
    second = await svc.start_dm(requester_id=bob.user_id, peer_id=alice.user_id)
    assert first.chat.id == second.chat.id


async def test_start_dm_self_raises():
    svc, users, *_ = _make()
    alice = users.add("alice")
    with pytest.raises(ValidationError):
        await svc.start_dm(requester_id=alice.user_id, peer_id=alice.user_id)


async def test_start_dm_unknown_peer_raises():
    svc, users, *_ = _make()
    alice = users.add("alice")
    with pytest.raises(NotFoundError):
        await svc.start_dm(requester_id=alice.user_id, peer_id="ghost")


async def test_start_dm_disabled_peer_raises():
    svc, users, *_ = _make()
    alice = users.add("alice")
    banned = users.add("banned", status="disabled")
    with pytest.raises(NotFoundError):
        await svc.start_dm(requester_id=alice.user_id, peer_id=banned.user_id)


async def test_start_dm_blocked_raises():
    svc, users, _chats, blocks, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    await blocks.block(bob.user_id, alice.user_id)
    with pytest.raises(AuthorizationError):
        await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)


async def test_start_dm_contacts_only_raises():
    svc, users, _chats, _blocks, directory, _events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    directory.set(bob.user_id, who_can_dm="contacts")
    with pytest.raises(AuthorizationError):
        await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)


async def test_start_dm_reuse_skips_contacts_gate():
    svc, users, _chats, _blocks, directory, _events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    first = await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)
    # bob later locks down to contacts-only; the existing dm still reopens
    directory.set(bob.user_id, who_can_dm="contacts")
    again = await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)
    assert first.chat.id == again.chat.id


# --- send_message ---


async def test_send_message_non_member_404():
    svc, users, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    stranger = users.add("stranger")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    with pytest.raises(NotFoundError):
        await svc.send_message(
            chat_id=chat.id, sender_id=stranger.user_id, content="hi"
        )


async def test_send_message_persists_and_fans_out():
    svc, users, _chats, _blocks, _directory, events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    msg = await svc.send_message(
        chat_id=chat.id, sender_id=alice.user_id, content="hello bob"
    )
    assert msg.content == "hello bob"
    assert len(events.published) == 1
    recipients, event = events.published[0]
    assert set(recipients) == {alice.user_id, bob.user_id}
    assert event["type"] == "chat_message"
    assert event["message"]["id"] == msg.id


async def test_send_message_blocked_dm_raises():
    svc, users, _chats, blocks, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    await blocks.block(bob.user_id, alice.user_id)
    with pytest.raises(AuthorizationError):
        await svc.send_message(chat_id=chat.id, sender_id=alice.user_id, content="hi")


async def test_reply_accepts_pending_request():
    svc, users, chats, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    # alice's opening message leaves bob pending (a message request)
    await svc.send_message(chat_id=chat.id, sender_id=alice.user_id, content="hi bob")
    assert (await chats.get_member(chat.id, bob.user_id)).state == "pending"
    # bob replying accepts the request
    await svc.send_message(chat_id=chat.id, sender_id=bob.user_id, content="hey")
    assert (await chats.get_member(chat.id, bob.user_id)).state == "accepted"


async def test_send_message_idempotent_client_msg_id():
    svc, users, _chats, _blocks, _directory, events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    first = await svc.send_message(
        chat_id=chat.id, sender_id=alice.user_id, content="hi", client_msg_id="c1"
    )
    second = await svc.send_message(
        chat_id=chat.id, sender_id=alice.user_id, content="hi", client_msg_id="c1"
    )
    assert first.id == second.id
    page = await svc.list_messages(chat_id=chat.id, user_id=alice.user_id)
    assert page.total == 1


# --- list_chats / unread / mark_read ---


async def test_list_chats_resolves_peer_and_unread():
    svc, users, _chats, _blocks, _directory, _events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    await svc.send_message(chat_id=chat.id, sender_id=bob.user_id, content="m1")
    last = await svc.send_message(chat_id=chat.id, sender_id=bob.user_id, content="m2")

    views = await svc.list_chats(user_id=alice.user_id)
    assert len(views) == 1
    assert views[0].peer.user_id == bob.user_id
    assert views[0].unread == 2

    await svc.mark_read(
        chat_id=chat.id, user_id=alice.user_id, last_read_message_id=last.id
    )
    views = await svc.list_chats(user_id=alice.user_id)
    assert views[0].unread == 0


async def test_list_chats_orders_recent_first():
    svc, users, _chats, _blocks, _directory, _events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    carol = users.add("carol")
    chat_b = (
        await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)
    ).chat
    chat_c = (
        await svc.start_dm(requester_id=alice.user_id, peer_id=carol.user_id)
    ).chat
    await svc.send_message(chat_id=chat_b.id, sender_id=alice.user_id, content="b")
    await svc.send_message(chat_id=chat_c.id, sender_id=alice.user_id, content="c")
    # chat_c has the most recent message -> it sorts first
    views = await svc.list_chats(user_id=alice.user_id)
    assert [v.chat.id for v in views] == [chat_c.id, chat_b.id]


# --- list_messages ---


async def test_list_messages_paginates():
    svc, users, _chats, _blocks, _directory, _events = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    for i in range(5):
        await svc.send_message(
            chat_id=chat.id, sender_id=alice.user_id, content=f"m{i}"
        )
    page = await svc.list_messages(
        chat_id=chat.id, user_id=alice.user_id, page=1, page_size=2
    )
    assert page.total == 5
    assert [m.content for m in page.messages] == ["m0", "m1"]
    page2 = await svc.list_messages(
        chat_id=chat.id, user_id=alice.user_id, page=2, page_size=2
    )
    assert [m.content for m in page2.messages] == ["m2", "m3"]


async def test_list_messages_non_member_404():
    svc, users, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    stranger = users.add("stranger")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    with pytest.raises(NotFoundError):
        await svc.list_messages(chat_id=chat.id, user_id=stranger.user_id)


async def test_mark_read_non_member_404():
    svc, users, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    stranger = users.add("stranger")
    chat = (await svc.start_dm(requester_id=alice.user_id, peer_id=bob.user_id)).chat
    with pytest.raises(NotFoundError):
        await svc.mark_read(
            chat_id=chat.id, user_id=stranger.user_id, last_read_message_id="x"
        )


# --- blocking ---


async def test_block_self_raises():
    svc, users, *_ = _make()
    alice = users.add("alice")
    with pytest.raises(ValidationError):
        await svc.block_user(user_id=alice.user_id, target_id=alice.user_id)


async def test_block_unknown_target_raises():
    svc, users, *_ = _make()
    alice = users.add("alice")
    with pytest.raises(NotFoundError):
        await svc.block_user(user_id=alice.user_id, target_id="ghost")


async def test_block_list_and_unblock_roundtrip():
    svc, users, *_ = _make()
    alice = users.add("alice")
    bob = users.add("bob")
    await svc.block_user(user_id=alice.user_id, target_id=bob.user_id)
    blocked = await svc.list_blocked(user_id=alice.user_id)
    assert [u.user_id for u in blocked] == [bob.user_id]
    await svc.unblock_user(user_id=alice.user_id, target_id=bob.user_id)
    assert await svc.list_blocked(user_id=alice.user_id) == []


# --- directory settings ---


async def test_directory_defaults_when_missing():
    svc, users, *_ = _make()
    alice = users.add("alice")
    view = await svc.get_directory_settings(user_id=alice.user_id)
    assert view.discoverable is True
    assert view.who_can_dm == "anyone"


async def test_update_directory_partial_preserves_other_field():
    svc, users, *_ = _make()
    alice = users.add("alice")
    await svc.update_directory_settings(user_id=alice.user_id, discoverable=False)
    view = await svc.update_directory_settings(
        user_id=alice.user_id, who_can_dm="contacts"
    )
    assert view.discoverable is False  # untouched by the second patch
    assert view.who_can_dm == "contacts"
