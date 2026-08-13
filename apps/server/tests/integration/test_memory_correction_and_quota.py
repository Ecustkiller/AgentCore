"""读取侧三洞的集成回归：纠错通道、为检索而写的描述、配额挤出可见。

- ① 纠错通道 (D6)：用户显式说「这条不对」后，那条记忆不再进系统提示、也不再进按需目录，
  但内容留着、可撤销，而且**扛得住 AI 之后整篇重写**（标记在列上，不在正文里）。
- ② 按需召回：目录摘要取条目的 ``description``（为检索而写），不是笔记第一行。
- ③ 配额挤出 (CTX-A2)：常驻池满时，被拒的是那一条写入，整趟整合继续跑，卡片按条目说清
  「什么没写进来 / 谁占着」。
"""

from __future__ import annotations

import uuid

import pytest

from agentcore.config import settings
from agentcore.db.repositories import (
    DocumentRepository,
    MemoryUpdateRepository,
    UserRepository,
)
from agentcore.memory import DocumentMemoryStore, assemble_injected_rules
from agentcore.memory.always_quota import memory_write_conversation_id
from agentcore.memory.injection import load_memory_topics
from agentcore.memory.rules_injection import _scope_on_demand_user_rules
from agentcore.memory.store import CORE_MEMORY_FILE, topic_path
from tests.integration.conftest import register_and_login


@pytest.fixture
def tiny_always_cap(monkeypatch):
    monkeypatch.setattr(settings, "memory_always_max_chars", 80)


def _entry(description: str, body: str, *, apply: str = "on_demand") -> str:
    return f"---\napply: {apply}\ndescription: {description}\n---\n{body}"


# --- ① 纠错通道 -------------------------------------------------------------------------------


async def test_disputed_user_rule_leaves_injection_but_keeps_content(session_factory):
    uid = str(uuid.uuid4())
    async with session_factory() as session:
        repo = DocumentRepository(session)
        store = DocumentMemoryStore(session=session)
        doc = await repo.create(
            uid,
            name="用户规则.md",
            role="rule",
            apply_mode="always",
            content="- 用户偏好 X",
        )
        assert "用户偏好 X" in await assemble_injected_rules(
            store, repo, uid, folder_id=None, enabled=True
        )

        marked = await repo.set_disputed(doc.id, user_id=uid, disputed=True)
        assert marked is not None and marked.disputed_at is not None

        assert "用户偏好 X" not in await assemble_injected_rules(
            store, repo, uid, folder_id=None, enabled=True
        )
        # Kept, not deleted: the user can still read (and undo) what was wrong.
        still_there = await repo.get(doc.id, user_id=uid)
        assert still_there is not None and "用户偏好 X" in still_there.content

        await repo.set_disputed(doc.id, user_id=uid, disputed=False)
        assert "用户偏好 X" in await assemble_injected_rules(
            store, repo, uid, folder_id=None, enabled=True
        )


async def test_disputed_ai_memory_core_survives_later_ai_rewrite(session_factory):
    """The mark lives in a column, so consolidation rewriting the note cannot erase it."""
    uid = str(uuid.uuid4())
    async with session_factory() as session:
        repo = DocumentRepository(session)
        store = DocumentMemoryStore(session=session)
        await store.save(uid, CORE_MEMORY_FILE, "## 技术栈与工具\n- 只用 Vue\n")
        note = await repo.get_memory_note(uid, CORE_MEMORY_FILE, None)
        assert note is not None
        await repo.set_disputed(note.id, user_id=uid, disputed=True)

        # AI keeps learning in the background — the entry may be rewritten…
        await store.save(uid, CORE_MEMORY_FILE, "## 技术栈与工具\n- 只用 Vue\n- 也用 Vite\n")

        rules_md = await assemble_injected_rules(
            store, repo, uid, folder_id=None, enabled=True
        )
        # …and still must not reach the prompt until the user lifts the mark.
        assert "只用 Vue" not in rules_md and "也用 Vite" not in rules_md
        after = await repo.get_memory_note(uid, CORE_MEMORY_FILE, None)
        assert after is not None and after.disputed_at is not None


async def test_disputed_entries_leave_the_on_demand_catalog(session_factory):
    uid = str(uuid.uuid4())
    async with session_factory() as session:
        repo = DocumentRepository(session)
        store = DocumentMemoryStore(session=session)
        rule = await repo.create(
            uid,
            name="合规附录.md",
            role="rule",
            apply_mode="on_demand",
            content=_entry("对外发布前查的合规口径", "- 对外须用中文"),
        )
        await store.save(
            uid,
            topic_path("部署流程"),
            _entry("发版怎么跑、卡住时来查", "## 要点\n- 先 build 再 deploy"),
        )
        topic = await repo.get_memory_note(uid, topic_path("部署流程"), None)
        assert topic is not None

        assert await _scope_on_demand_user_rules(repo, uid, None) == [
            ("合规附录", "对外发布前查的合规口径")
        ]
        topics = await load_memory_topics(store, uid, folder_id=None, enabled=True)
        assert [(t.name, t.summary) for t in topics] == [
            ("部署流程", "发版怎么跑、卡住时来查")
        ]

        await repo.set_disputed(rule.id, user_id=uid, disputed=True)
        await repo.set_disputed(topic.id, user_id=uid, disputed=True)

        assert await _scope_on_demand_user_rules(repo, uid, None) == []
        assert await load_memory_topics(store, uid, folder_id=None, enabled=True) == []


async def test_dispute_patch_endpoint_roundtrip(client):
    await register_and_login(client, "mem_dispute")
    created = (
        await client.post(
            "/v1/documents",
            json={
                "name": "过时偏好.md",
                "role": "rule",
                "apply_mode": "always",
                "content": "- 早就不对了",
            },
        )
    ).json()
    assert created["disputed_at"] is None

    r = await client.patch(f"/v1/documents/{created['id']}", json={"disputed": True})
    assert r.status_code == 200, r.text
    assert r.json()["disputed_at"]

    # Still listed and still readable — dispute is not a delete.
    fetched = (await client.get(f"/v1/documents/{created['id']}")).json()
    assert fetched["disputed_at"] and "早就不对了" in fetched["content"]

    r = await client.patch(f"/v1/documents/{created['id']}", json={"disputed": False})
    assert r.status_code == 200 and r.json()["disputed_at"] is None


async def test_disputed_always_entry_stops_spending_quota(client):
    """A disputed entry does not inject, so it must not hold the pool either."""
    await register_and_login(client, "mem_dispute_quota")
    doc = (
        await client.post(
            "/v1/documents",
            json={
                "name": "占位.md",
                "role": "rule",
                "apply_mode": "always",
                "content": "12345",
            },
        )
    ).json()
    before = (await client.get("/v1/documents/always-quota")).json()["used_chars"]
    assert before >= len("12345")

    await client.patch(f"/v1/documents/{doc['id']}", json={"disputed": True})
    after = (await client.get("/v1/documents/always-quota")).json()["used_chars"]
    assert after == before - len("12345")


# --- ② 为检索而写的描述 -----------------------------------------------------------------------


async def test_ai_topic_write_schedules_description_fill(session_factory, monkeypatch):
    """A topic with no description is unfindable — AI writes queue the async fill."""
    scheduled: list[str] = []
    monkeypatch.setattr(
        "agentcore.documents.description.schedule_description_generation",
        lambda *, document_id, user_id: scheduled.append(document_id),
    )
    uid = str(uuid.uuid4())
    async with session_factory() as session:
        store = DocumentMemoryStore(session=session)
        repo = DocumentRepository(session)
        await store.save(uid, topic_path("部署流程"), "## 要点\n- 先 build 再 deploy\n")
        await store.save(uid, CORE_MEMORY_FILE, "## 技术栈与工具\n- 用 Python\n")
        topic = await repo.get_memory_note(uid, topic_path("部署流程"), None)
        assert topic is not None
        core = await repo.get_memory_note(uid, CORE_MEMORY_FILE, None)
        assert core is not None
    # Only the on-demand topic: an always core rides the prompt whole and needs none.
    assert scheduled == [topic.id]


async def test_topic_written_with_description_skips_fill(session_factory, monkeypatch):
    scheduled: list[str] = []
    monkeypatch.setattr(
        "agentcore.documents.description.schedule_description_generation",
        lambda *, document_id, user_id: scheduled.append(document_id),
    )
    uid = str(uuid.uuid4())
    async with session_factory() as session:
        store = DocumentMemoryStore(session=session)
        await store.save(
            uid,
            topic_path("部署流程"),
            _entry("发版怎么跑、卡住时来查", "## 要点\n- 先 build"),
        )
    assert scheduled == []


# --- ③ 配额挤出可见 (CTX-A2) ------------------------------------------------------------------


async def test_quota_card_names_denied_entry_and_holders(
    client, session_factory, tiny_always_cap, monkeypatch
):
    import agentcore.db.base as db_base

    monkeypatch.setattr(db_base, "async_session_factory", session_factory)
    await register_and_login(client, "aq_visible")
    conv = str(uuid.uuid4())

    async with session_factory() as session:
        user = await UserRepository(session).get_by_username("aq_visible")
        assert user is not None
        uid = user.user_id
        await DocumentRepository(session).create(
            uid,
            name="占坑规则.md",
            role="rule",
            apply_mode="always",
            content="z" * 100,
        )

    async with session_factory() as session:
        store = DocumentMemoryStore(session)
        token = memory_write_conversation_id.set(conv)
        try:
            from agentcore.memory.always_quota import AlwaysQuotaExceededError

            with pytest.raises(AlwaysQuotaExceededError):
                await store.save(uid, CORE_MEMORY_FILE, "---\napply: always\n---\n" + "a" * 40)
        finally:
            memory_write_conversation_id.reset(token)

    async with session_factory() as session:
        rows = await MemoryUpdateRepository(session).list_for_conversation(conv, limit=20)
    quota_rows = [r for r in rows if r.kind == "quota"]
    assert len(quota_rows) == 1
    items = quota_rows[0].items
    denied = [it for it in items if it["action"] == "quota_denied"]
    holders = [it for it in items if it["action"] == "quota_holder"]
    # 条目级可见：哪一条没写进来 + 现在谁占着池子。
    assert [it["file"] for it in denied] == ["画像"]
    assert any(it["file"] == "占坑规则.md" and "占用" in it["content"] for it in holders)
    assert "没能写进常驻" in (quota_rows[0].summary or "")
    # 诚实：没有静默淘汰，占坑的那条还在。
    async with session_factory() as session:
        kept = await DocumentRepository(session).list_injectable_rules(
            uid, None, ai_maintained=None
        )
    assert any(d.name == "占坑规则.md" for d in kept)


async def test_full_pool_denies_one_entry_but_pass_continues(
    client, session_factory, tiny_always_cap, monkeypatch
):
    """CTX-A2: a full always pool must not read as「AI 从此记不住东西」."""
    import agentcore.db.base as db_base
    from agentcore.memory.episode_store import EpisodeRecord
    from agentcore.memory.maintenance import MemoryUpdateItem
    from agentcore.memory.semantic import consolidate_semantic_memory
    from agentcore.memory.user_memory import MemoryAction, MemoryOp

    monkeypatch.setattr(db_base, "async_session_factory", session_factory)
    await register_and_login(client, "aq_pass")
    conv = str(uuid.uuid4())

    async with session_factory() as session:
        user = await UserRepository(session).get_by_username("aq_pass")
        assert user is not None
        uid = user.user_id
        await DocumentRepository(session).create(
            uid,
            name="占坑规则.md",
            role="rule",
            apply_mode="always",
            content="z" * 100,
        )

    class _Consolidator:
        """Rewrites the always profile (will be refused) AND adds a topic (must land)."""

        async def consolidate(self, data):
            from agentcore.memory.semantic import SemanticConsolidateResult

            return SemanticConsolidateResult(
                profile="## 技术栈与工具\n- " + "新事实" * 10,
                ops=[
                    MemoryOp(
                        action=MemoryAction.ADD,
                        file=topic_path("部署流程"),
                        section="要点",
                        content="先 build 再 deploy",
                        scope=None,
                    )
                ],
            )

    episodes = [
        EpisodeRecord(
            id=str(uuid.uuid4()),
            conversation_id=conv,
            summary="讨论了发版",
            created_at="2026-08-13T00:00:00+00:00",
        )
    ]
    items: list[MemoryUpdateItem] = []
    async with session_factory() as session:
        store = DocumentMemoryStore(session)
        token = memory_write_conversation_id.set(conv)
        try:
            changed = await consolidate_semantic_memory(
                user_id=uid,
                episodes=episodes,
                consolidator=_Consolidator(),
                store=store,
                collect_items=items,
            )
        finally:
            memory_write_conversation_id.reset(token)

    # The refused always write did not abort the pass: the on-demand topic still landed.
    assert changed is True
    async with session_factory() as session:
        repo = DocumentRepository(session)
        topic = await repo.get_memory_note(uid, topic_path("部署流程"), None)
        profile = await repo.get_memory_note(uid, CORE_MEMORY_FILE, None)
    assert topic is not None and "先 build 再 deploy" in topic.content
    assert profile is None  # the denied entry was never created

    async with session_factory() as session:
        rows = await MemoryUpdateRepository(session).list_for_conversation(conv, limit=20)
    quota_rows = [r for r in rows if r.kind == "quota"]
    assert len(quota_rows) == 1
    assert [it["file"] for it in quota_rows[0].items if it["action"] == "quota_denied"] == [
        "画像"
    ]
