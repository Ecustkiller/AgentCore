"""回合顶「最近活动」；改名不顶；grouped 预览是最后可见助手，停止不回落用户句。"""

from datetime import UTC, datetime

from sqlalchemy import select, update

from agentcore.core.message_merge import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_INCOMPLETE,
)
from agentcore.db.models import Conversation
from agentcore.db.repositories import MessageRepository
from agentcore.runtime.events.types import FinishReason
from tests.integration.conftest import register_and_login


async def _updated_at(session_factory, conversation_id: str) -> datetime:
    async with session_factory() as session:
        stamp = await session.scalar(
            select(Conversation.updated_at).where(Conversation.id == conversation_id)
        )
    assert stamp is not None
    return stamp


async def test_turn_bumps_updated_at_rename_does_not(client, session_factory):
    await register_and_login(client, "listact1")
    cid = (await client.post("/v1/conversations", json={"title": "原标题"})).json()["id"]
    aged = datetime(2026, 1, 1, tzinfo=UTC)
    async with session_factory() as session:
        await session.execute(
            update(Conversation).where(Conversation.id == cid).values(updated_at=aged)
        )
        await session.commit()

    async with session_factory() as session:
        await MessageRepository(session).create(
            conversation_id=cid, role="user", content="用户问题"
        )
    after_user = await _updated_at(session_factory, cid)
    assert after_user > aged

    async with session_factory() as session:
        await MessageRepository(session).upsert_assistant(
            conversation_id=cid,
            content="助手可见句",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )
    after_assistant = await _updated_at(session_factory, cid)
    assert after_assistant > after_user

    patched = await client.patch(f"/v1/conversations/{cid}", json={"title": "改名后"})
    assert patched.status_code == 200, patched.text
    assert patched.json()["title"] == "改名后"
    after_rename = await _updated_at(session_factory, cid)
    assert after_rename == after_assistant


async def test_grouped_preview_is_last_visible_assistant_not_user_on_stop(
    client, session_factory
):
    await register_and_login(client, "listact2")
    cid = (await client.post("/v1/conversations", json={"title": "预览"})).json()["id"]

    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content="用户问题")
        await repo.upsert_assistant(
            conversation_id=cid,
            content="上次成功回复",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )

    body = (await client.get("/v1/conversations/grouped")).json()
    row = next(c for c in body["ungrouped"] if c["id"] == cid)
    assert row["last_message_preview"] == "上次成功回复"

    before_stop = await _updated_at(session_factory, cid)
    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content="请继续")
        await repo.upsert_assistant(
            conversation_id=cid,
            content="",
            metadata={
                "status": MESSAGE_STATUS_INCOMPLETE,
                "incomplete": True,
                "finish_reason": FinishReason.CANCELLED.value,
            },
        )
    after_stop = await _updated_at(session_factory, cid)
    assert after_stop > before_stop

    body = (await client.get("/v1/conversations/grouped")).json()
    row = next(c for c in body["ungrouped"] if c["id"] == cid)
    assert row["last_message_preview"] == "上次成功回复"
    assert row["last_message_preview"] != "请继续"
    assert "用户" not in (row["last_message_preview"] or "")


async def test_grouped_preview_skips_running_placeholder(client, session_factory):
    await register_and_login(client, "listact3")
    cid = (await client.post("/v1/conversations", json={"title": "占位"})).json()["id"]

    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content="先问一句")
        await repo.upsert_assistant(
            conversation_id=cid,
            content="已有助手句",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )
        await repo.create_assistant_placeholder(
            conversation_id=cid, message_id="aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        )

    body = (await client.get("/v1/conversations/grouped")).json()
    row = next(c for c in body["ungrouped"] if c["id"] == cid)
    assert row["last_message_preview"] == "已有助手句"

    listed = (await client.get("/v1/conversations?page_size=20")).json()
    listed_row = next(c for c in listed["data"] if c["id"] == cid)
    assert listed_row["last_message_preview"] == "已有助手句"


async def test_duplicate_carries_last_visible_assistant_preview(
    client, session_factory
):
    await register_and_login(client, "listact5")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content="用户问题")
        await repo.upsert_assistant(
            conversation_id=cid,
            content="克隆应带上的助手句",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )

    dup = await client.post(f"/v1/conversations/{cid}/duplicate")
    assert dup.status_code == 201, dup.text
    body = dup.json()
    assert body["last_message_preview"] == "克隆应带上的助手句"
    assert body["last_message_preview"] != "用户问题"


async def test_empty_conversation_preview_is_null(client):
    await register_and_login(client, "listact4")
    cid = (await client.post("/v1/conversations", json={"title": "空"})).json()["id"]
    body = (await client.get("/v1/conversations/grouped")).json()
    row = next(c for c in body["ungrouped"] if c["id"] == cid)
    assert row["last_message_preview"] is None
    assert row["message_count"] == 0
