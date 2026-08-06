"""Historical messages.followups column round-trip (chips mint offline).

``set_followups`` remains for the retained DB column / admin paths; live finalize
no longer calls it. These pin the durable half — write + ``MessageDetail`` read.
Real PostgreSQL; auto-skips without it (see ``integration/conftest``).
"""

from __future__ import annotations

from agentcore.api.schemas.messages import MessageDetail
from agentcore.db.repositories import (
    ConversationRepository,
    MessageRepository,
    UserRepository,
)


async def test_followups_column_persist_and_project(session_factory) -> None:
    """Column round-trip still works; new turns simply never write."""
    async with session_factory() as s:
        user = await UserRepository(s).create(username="fu-user", display_name="U")
        conv = await ConversationRepository(s).create(user_id=user.user_id, title="chat")

    async with session_factory() as s:
        msg = await MessageRepository(s).create(
            conversation_id=conv.id, role="assistant", content="好的，方案如下"
        )

    async with session_factory() as s:
        row = await MessageRepository(s).get_by_id(msg.id, conversation_id=conv.id)
        assert row is not None
        assert row.followups == []
        assert MessageDetail.model_validate(row).followups == []

    chips = ["帮我导出 PDF", "再做一版竞品对比"]
    async with session_factory() as s:
        await MessageRepository(s).set_followups(
            msg.id, conversation_id=conv.id, followups=chips
        )

    async with session_factory() as s:
        row = await MessageRepository(s).get_by_id(msg.id, conversation_id=conv.id)
        assert row is not None
        assert row.followups == chips
        assert MessageDetail.model_validate(row).followups == chips


async def test_set_followups_is_conversation_scoped(session_factory) -> None:
    """A mismatched conversation_id is a harmless no-op (defense in depth)."""
    async with session_factory() as s:
        user = await UserRepository(s).create(username="fu-user2", display_name="U2")
        conv = await ConversationRepository(s).create(user_id=user.user_id, title="chat")

    async with session_factory() as s:
        msg = await MessageRepository(s).create(
            conversation_id=conv.id, role="assistant", content="hi"
        )

    async with session_factory() as s:
        await MessageRepository(s).set_followups(
            msg.id,
            conversation_id="00000000-0000-0000-0000-000000000000",
            followups=["不该落到别的会话"],
        )

    async with session_factory() as s:
        row = await MessageRepository(s).get_by_id(msg.id, conversation_id=conv.id)
        assert row is not None
        assert row.followups == []
