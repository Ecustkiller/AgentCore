"""一次发送只建一条会话：``POST /v1/conversations`` 的 ``client_request_id`` 幂等键。

线上 7 天 8 起「一次发送建出两条内容完全相同的会话」，涉 4 个用户，最短间隔 14ms
（客户端并发多发）、最长 16.9s（用户重按）。两条各跑完一整轮 → 双倍计费。这里钉住
三条不变量：

1. **同键重复 = 同一条**——第二次起原样返回首次那条，仍是 201、body 同形，不报错；
2. **并发同键只落一行**——两个连接都错过「先查」时，唯一索引是最后的裁判，输的那个
   把冲突读成「别人已经建好了」而不是错误；
3. **不传键 = 旧行为**——老客户端一次请求一条，绝不按「同用户 / 同标题 / N 秒内」
   之类的启发式替它去重。

跑这些必须有真 PostgreSQL：局部唯一索引才是被验的东西，SQLite / 内存假仓验不了。
"""

from __future__ import annotations

import asyncio

from sqlalchemy import func, select

from agentcore.db.models import Conversation
from agentcore.db.repositories import ConversationRepository
from tests.conftest import LogSpy
from tests.integration.conftest import register_and_login

_KEY = "send-42"


async def _count_conversations(session_factory, user_id: str) -> int:
    async with session_factory() as s:
        return (
            await s.execute(
                select(func.count())
                .select_from(Conversation)
                .where(Conversation.user_id == user_id)
            )
        ).scalar_one()


# --- HTTP contract -----------------------------------------------------------


async def test_same_key_twice_returns_the_same_conversation(client, session_factory):
    """重按「新建」：第二次拿回第一条，不是第二条。"""
    user_id = await register_and_login(client, "idem-repeat")

    first = await client.post(
        "/v1/conversations", json={"title": "季度复盘", "client_request_id": _KEY}
    )
    assert first.status_code == 201, first.text
    second = await client.post(
        "/v1/conversations", json={"title": "季度复盘", "client_request_id": _KEY}
    )
    assert second.status_code == 201, second.text

    assert second.json()["id"] == first.json()["id"]
    # 同形：重复请求拿到的不是精简版，而是与首次一模一样的 body。
    assert second.json() == first.json()
    assert await _count_conversations(session_factory, user_id) == 1


async def test_repeat_ignores_a_changed_body(client, session_factory):
    """键相同、正文不同 → 仍是首次那条；幂等键认的是「哪一次发送」，不是内容。"""
    user_id = await register_and_login(client, "idem-changed-body")

    first = await client.post(
        "/v1/conversations", json={"title": "原标题", "client_request_id": _KEY}
    )
    second = await client.post(
        "/v1/conversations", json={"title": "改过的标题", "client_request_id": _KEY}
    )

    assert second.json()["id"] == first.json()["id"]
    assert second.json()["title"] == "原标题"
    assert await _count_conversations(session_factory, user_id) == 1


async def test_concurrent_same_key_creates_one_row(client, session_factory):
    """14ms 那一档：同键并发多发，只落一行，所有响应指向同一条。"""
    user_id = await register_and_login(client, "idem-concurrent")

    responses = await asyncio.gather(
        *(
            client.post(
                "/v1/conversations", json={"title": "并发", "client_request_id": _KEY}
            )
            for _ in range(5)
        )
    )

    assert [r.status_code for r in responses] == [201] * 5, [r.text for r in responses]
    assert len({r.json()["id"] for r in responses}) == 1
    assert await _count_conversations(session_factory, user_id) == 1


async def test_no_key_keeps_creating_one_conversation_per_request(client, session_factory):
    """老客户端不传键：两次相同请求照样两条会话，不拦、不报错、不去重。"""
    user_id = await register_and_login(client, "idem-absent")

    first = await client.post("/v1/conversations", json={"title": "一样的标题"})
    second = await client.post("/v1/conversations", json={"title": "一样的标题"})

    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert await _count_conversations(session_factory, user_id) == 2


async def test_key_is_scoped_per_user(client, new_client, session_factory):
    """幂等键按用户隔离：两个用户各自铸出同一个字符串不该互相吞掉对方的会话。"""
    await register_and_login(client, "idem-owner-a")
    mine = await client.post(
        "/v1/conversations", json={"title": "我的", "client_request_id": _KEY}
    )
    assert mine.status_code == 201, mine.text

    async with new_client() as other:
        await register_and_login(other, "idem-owner-b")
        theirs = await other.post(
            "/v1/conversations", json={"title": "他的", "client_request_id": _KEY}
        )
        assert theirs.status_code == 201, theirs.text
        assert theirs.json()["id"] != mine.json()["id"]
        assert theirs.json()["title"] == "他的"


async def test_blank_key_is_treated_as_absent(client, session_factory):
    """空白键不是键：不能让 "" / " " 把一个用户的所有新建折叠成一条。"""
    user_id = await register_and_login(client, "idem-blank")

    first = await client.post("/v1/conversations", json={"client_request_id": "   "})
    second = await client.post("/v1/conversations", json={"client_request_id": "   "})

    assert first.status_code == 201 and second.status_code == 201
    assert first.json()["id"] != second.json()["id"]
    assert await _count_conversations(session_factory, user_id) == 2


# --- observability -----------------------------------------------------------


async def test_create_logs_are_attributable_and_mark_the_repeat(client, monkeypatch):
    """创建动作必须在服务端留痕，且能一眼看出哪一次是重复请求没干活。"""
    from agentcore.api.routes.conversations import crud

    spy = LogSpy()
    monkeypatch.setattr(crud, "logger", spy)

    user_id = await register_and_login(client, "idem-logged")
    first = await client.post(
        "/v1/conversations", json={"title": "留痕", "client_request_id": _KEY}
    )
    await client.post(
        "/v1/conversations", json={"title": "留痕", "client_request_id": _KEY}
    )

    lines = [kw for name, kw in spy.events if name == "conversation.created"]
    assert len(lines) == 2
    assert [line["idempotent_hit"] for line in lines] == [False, True]
    for line in lines:
        assert line["user_id"] == user_id
        assert line["conversation_id"] == first.json()["id"]
        assert line["client_request_id"] == _KEY
        assert line["folder_id"] is None


async def test_create_without_key_is_still_logged(client, monkeypatch):
    """不传键的新建同样留痕——线上此前对「建了几条」完全不可观测。"""
    from agentcore.api.routes.conversations import crud

    spy = LogSpy()
    monkeypatch.setattr(crud, "logger", spy)

    await register_and_login(client, "idem-logged-nokey")
    await client.post("/v1/conversations", json={"title": "无键"})

    line = spy.get("conversation.created")
    assert line["client_request_id"] is None
    assert line["idempotent_hit"] is False


# --- repository: the unique index, not the lookup ----------------------------


async def test_insert_race_loser_gets_the_winners_row(session_factory):
    """两个连接都错过「先查」时，唯一索引兜住，输家把冲突读成「已经有了」。

    先查后插在并发下必然漏——这里把那一刻钉死：A 插入但不提交，B 的先查扑空、插入被
    索引挡在门外（``assert not task.done()`` 证明挡的是索引，不是那次 SELECT），A 提交
    后 B 拿到唯一键冲突，必须回查出 A 那一条并原样返回，而不是把 500 抛给用户。
    """
    user_id = "11111111-1111-1111-1111-111111111111"

    async with session_factory() as winner_session:
        # commit=False：行已写进索引但事务未结束，正是 14ms 窗口里的那一瞬。
        winner = await ConversationRepository(winner_session).create(
            user_id=user_id, title="先到", client_request_id=_KEY, commit=False
        )

        async def _loser() -> tuple[str, bool]:
            async with session_factory() as s:
                conv, created = await ConversationRepository(s).create_idempotent(
                    user_id=user_id, client_request_id=_KEY, title="后到"
                )
                return conv.id, created

        task = asyncio.create_task(_loser())
        await asyncio.sleep(0.3)
        assert not task.done(), "输家应当卡在唯一索引上，而不是先查就返回"

        await winner_session.commit()
        loser_id, loser_created = await asyncio.wait_for(task, timeout=10)

    assert loser_id == winner.id
    assert loser_created is False
    async with session_factory() as s:
        rows = (
            await s.execute(select(Conversation).where(Conversation.user_id == user_id))
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].title == "先到"


async def test_create_idempotent_reports_whether_it_created(session_factory):
    """``created`` 是日志里 ``idempotent_hit`` 的唯一来源，别让它退化成恒 True。"""
    user_id = "22222222-2222-2222-2222-222222222222"

    async with session_factory() as s:
        first, created_first = await ConversationRepository(s).create_idempotent(
            user_id=user_id, client_request_id=_KEY, title="一"
        )
    async with session_factory() as s:
        second, created_second = await ConversationRepository(s).create_idempotent(
            user_id=user_id, client_request_id=_KEY, title="二"
        )

    assert created_first is True
    assert created_second is False
    assert second.id == first.id


async def test_key_lookup_still_finds_a_deleted_conversation(session_factory):
    """查询谓词必须与局部唯一索引一致：软删了的行仍占着键，就仍要能被查回来。

    若这里跟着 ``deleted_at`` 过滤，同一个键的第二次请求会先查不到、再撞上仍然活着的
    索引行、回查又落空——一个只可能 500 的请求。
    """
    user_id = "33333333-3333-3333-3333-333333333333"

    async with session_factory() as s:
        repo = ConversationRepository(s)
        conv, _ = await repo.create_idempotent(
            user_id=user_id, client_request_id=_KEY, title="待删"
        )
        assert await repo.soft_delete(conv.id, user_id=user_id) is True

    async with session_factory() as s:
        repo = ConversationRepository(s)
        again, created = await repo.create_idempotent(
            user_id=user_id, client_request_id=_KEY, title="重来"
        )
    assert created is False
    assert again.id == conv.id


async def test_absent_key_never_collides(session_factory):
    """局部索引跳过不带键的行：同一用户可以有任意多条 NULL 键的会话。"""
    user_id = "44444444-4444-4444-4444-444444444444"

    async with session_factory() as s:
        repo = ConversationRepository(s)
        a = await repo.create(user_id=user_id, title="裸聊 1")
        b = await repo.create(user_id=user_id, title="裸聊 2")

    assert a.id != b.id
    async with session_factory() as s:
        count = (
            await s.execute(
                select(func.count())
                .select_from(Conversation)
                .where(
                    Conversation.user_id == user_id,
                    Conversation.client_request_id.is_(None),
                )
            )
        ).scalar_one()
    assert count == 2
