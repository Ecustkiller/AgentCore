"""克隆对话：拷到 until_message_id 为止；无截止 / 进行中 / 外对话消息拒绝。"""

from agentcore.core.message_merge import MESSAGE_STATUS_COMPLETE
from agentcore.core.types import new_id
from agentcore.db.repositories import MessageRepository
from tests.integration.conftest import register_and_login


async def test_duplicate_requires_until_message_id(client):
    await register_and_login(client, "dupreq")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    r = await client.post(f"/v1/conversations/{cid}/duplicate")
    assert r.status_code == 422


async def test_duplicate_stops_at_cutoff_and_leaves_source(client, session_factory):
    await register_and_login(client, "dupcut")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content="q1")
        first = await repo.upsert_assistant(
            conversation_id=cid,
            content="a1",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )
        await repo.create(conversation_id=cid, role="user", content="q2")
        await repo.upsert_assistant(
            conversation_id=cid,
            content="a2",
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )
        cutoff = first.id

    dup = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff},
    )
    assert dup.status_code == 201, dup.text
    body = dup.json()
    assert body["id"] != cid
    assert body["title"] == "源 (1)"
    assert body["message_count"] == 2
    assert body["last_message_preview"] == "a1"

    async with session_factory() as session:
        repo = MessageRepository(session)
        copied = await repo.list_all_for_conversation(body["id"])
        source = await repo.list_all_for_conversation(cid)
    assert [m.content for m in copied] == ["q1", "a1"]
    assert [m.content for m in source] == ["q1", "a1", "q2", "a2"]


async def test_duplicate_unknown_message_404(client, session_factory):
    await register_and_login(client, "dup404")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    other = (await client.post("/v1/conversations", json={"title": "旁"})).json()["id"]
    async with session_factory() as session:
        repo = MessageRepository(session)
        foreign = await repo.create(
            conversation_id=other, role="user", content="别人的"
        )

    missing = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": new_id()},
    )
    assert missing.status_code == 404

    stolen = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": foreign.id},
    )
    assert stolen.status_code == 404


async def test_duplicate_running_cutoff_409(client, session_factory):
    await register_and_login(client, "duprun")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    async with session_factory() as session:
        repo = MessageRepository(session)
        ph = await repo.create_assistant_placeholder(
            conversation_id=cid, message_id=new_id()
        )

    r = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": ph.id},
    )
    assert r.status_code == 409


async def _seed_turn(session_factory, cid: str, *, user: str, assistant: str):
    async with session_factory() as session:
        repo = MessageRepository(session)
        await repo.create(conversation_id=cid, role="user", content=user)
        return await repo.upsert_assistant(
            conversation_id=cid,
            content=assistant,
            metadata={"status": MESSAGE_STATUS_COMPLETE},
        )


async def test_duplicate_numbers_second_fork(client, session_factory):
    await register_and_login(client, "dupnum")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    cutoff = await _seed_turn(session_factory, cid, user="q", assistant="a")

    first = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    second = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    assert first.status_code == 201, first.text
    assert second.status_code == 201, second.text
    assert first.json()["title"] == "源 (1)"
    assert second.json()["title"] == "源 (2)"


async def test_duplicate_peels_legacy_copy_suffix(client, session_factory):
    await register_and_login(client, "duplegacy")
    cid = (await client.post("/v1/conversations", json={"title": "源 副本"})).json()[
        "id"
    ]
    cutoff = await _seed_turn(session_factory, cid, user="q", assistant="a")
    dup = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    assert dup.status_code == 201, dup.text
    assert dup.json()["title"] == "源 (1)"


async def test_duplicate_empty_title_uses_fallback(client, session_factory):
    await register_and_login(client, "dupempty")
    cid = (await client.post("/v1/conversations", json={})).json()["id"]
    cutoff = await _seed_turn(
        session_factory, cid, user="帮我写周报", assistant="好"
    )
    dup = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    assert dup.status_code == 201, dup.text
    assert dup.json()["title"] == "帮我写周报 (1)"


async def test_duplicate_archived_slot_is_free(client, session_factory):
    await register_and_login(client, "duparch")
    cid = (await client.post("/v1/conversations", json={"title": "源"})).json()["id"]
    cutoff = await _seed_turn(session_factory, cid, user="q", assistant="a")
    first = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    assert first.status_code == 201, first.text
    archived = await client.patch(
        f"/v1/conversations/{first.json()['id']}", json={"archived": True}
    )
    assert archived.status_code == 200, archived.text
    second = await client.post(
        f"/v1/conversations/{cid}/duplicate",
        json={"until_message_id": cutoff.id},
    )
    assert second.status_code == 201, second.text
    assert second.json()["title"] == "源 (1)"
