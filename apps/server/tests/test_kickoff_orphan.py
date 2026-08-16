"""一会话一张开工卡：persist 前 orphan 旧 pending team_preview（journal ∪ 进程内 + SSE）。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from agentcore.runtime.events import EventSink, EventType, team_preview_required
from agentcore.runtime.kickoff.orphan import (
    list_journal_pending_team_previews,
    orphan_conversation_team_previews,
    remember_live_team_preview,
    reset_team_preview_orphan_state,
)
from agentcore.runtime.kickoff.pause import persist_kickoff
from agentcore.runtime.kickoff.summary import KickoffSummary


@pytest.fixture(autouse=True)
def _reset_orphan_state():
    reset_team_preview_orphan_state()
    yield
    reset_team_preview_orphan_state()


def _summary() -> KickoffSummary:
    return KickoffSummary(
        primitive="delegate",
        workers=[{"run_id": "r1", "role": "调研", "task": "a"}],
        tools=[],
        headline="预计 1 人开工",
    )


def _required(conversation_id: str, checkpoint_id: str):
    return team_preview_required(
        checkpoint_id=checkpoint_id,
        conversation_id=conversation_id,
        workers=[{"run_id": "r1", "role": "调研", "task": "a"}],
    )


def _host(sink: EventSink, *, conversation_id: str = "conv-orphan", message_id: str = "m1"):
    ctx = SimpleNamespace(
        user_id="u",
        folder_binding_injected=False,
        folder_local_root_id=None,
        folder_local_subpath=None,
    )

    async def _save(_frame):
        return None

    return SimpleNamespace(
        _sink=sink,
        _message_id=message_id,
        _conversation_id=conversation_id,
        _suspension_saver=_save,
        _pending_pause=False,
        _depth=0,
        _captain_run_id="CEO",
        _user_message="原始请求",
        _folder_id=None,
        _memory_enabled=True,
        _conversation_history_access=True,
        _base_tool_context=ctx,
        _registry=object(),
        _kickoff_system_prompt=lambda: "SYS",
        _kickoff_tool_name=lambda: "delegate",
    )


def _patch_persist_ok(monkeypatch: pytest.MonkeyPatch, impl=None):
    async def _ok(**_k):
        return True

    monkeypatch.setattr(
        "agentcore.runtime.suspension.capture.persist_suspension_capture",
        impl or _ok,
    )


def _patch_empty_journal(monkeypatch: pytest.MonkeyPatch):
    async def _empty(_cid: str):
        return []

    monkeypatch.setattr(
        "agentcore.runtime.kickoff.orphan.list_journal_pending_team_previews",
        _empty,
    )


def _patch_orphan_fact(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    facts: list[dict] = []

    async def _fake_emit(**kwargs):
        facts.append(kwargs)

    monkeypatch.setattr(
        "agentcore.runtime.interaction_orphan.emit_orphan_fact",
        _fake_emit,
    )
    return facts


async def test_second_persist_orphans_first_journal_and_sse(monkeypatch):
    """第二张 persist 后：第一张 journal+SSE orphan，新卡自己不被 orphan。"""
    _patch_persist_ok(monkeypatch)
    _patch_empty_journal(monkeypatch)
    facts = _patch_orphan_fact(monkeypatch)
    sink = EventSink()
    host = _host(sink)
    summary = _summary()

    assert await persist_kickoff(host, "tp1", summary, _required("conv-orphan", "tp1"))
    assert await persist_kickoff(host, "tp2", summary, _required("conv-orphan", "tp2"))

    assert [f["interaction_id"] for f in facts] == ["tp1"]
    assert facts[0]["kind"] == "team_preview"
    assert facts[0]["reason"] == "superseded"
    assert facts[0]["turn_id"] == "m1"
    assert facts[0]["prefer_direct"] is True

    orphaned_sse = [e for e in sink._history if e.type is EventType.INTERACTION_ORPHANED]
    assert len(orphaned_sse) == 1
    assert orphaned_sse[0].payload["interaction_id"] == "tp1"
    assert orphaned_sse[0].payload["kind"] == "team_preview"
    assert orphaned_sse[0].payload["reason"] == "superseded"

    required = [e for e in sink._history if e.type is EventType.TEAM_PREVIEW_REQUIRED]
    assert [e.payload["checkpoint_id"] for e in required] == ["tp1", "tp2"]
    assert "tp2" not in {e.payload["interaction_id"] for e in orphaned_sse}


async def test_persist_orphans_journal_pending_not_self(monkeypatch):
    """Journal 已有旧 pending：新 persist 只 orphan 旧卡，exclude 新卡 id。"""
    _patch_persist_ok(monkeypatch)
    facts = _patch_orphan_fact(monkeypatch)

    async def _journal(_cid: str):
        return [("old-turn", "tp_old", {"checkpoint_id": "tp_old"})]

    monkeypatch.setattr(
        "agentcore.runtime.kickoff.orphan.list_journal_pending_team_previews",
        _journal,
    )
    sink = EventSink()
    host = _host(sink)

    assert await persist_kickoff(host, "tp_new", _summary(), _required("conv-orphan", "tp_new"))

    assert [f["interaction_id"] for f in facts] == ["tp_old"]
    assert facts[0]["turn_id"] == "old-turn"
    orphaned_sse = [e for e in sink._history if e.type is EventType.INTERACTION_ORPHANED]
    assert orphaned_sse[0].payload["interaction_id"] == "tp_old"
    assert "tp_new" not in {f["interaction_id"] for f in facts}


async def test_orphan_skips_ask_user(monkeypatch):
    """ask_user pending 不进开工卡 orphan 面（澄清卡 ⊥ 开工卡）。"""
    facts = _patch_orphan_fact(monkeypatch)

    class Repo:
        async def list_recent_turn_ids(self, _cid, limit=40):
            return ["turn-a"]

        async def load(self, _turn_id):
            return [
                {
                    "kind": "checkpoint_required",
                    "payload": {"checkpoint_id": "ask1", "question": "交付形态？"},
                },
                {
                    "kind": "team_preview_required",
                    "payload": {"checkpoint_id": "tp1", "workers": []},
                },
            ]

    class _Sess:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

    monkeypatch.setattr("agentcore.db.base.async_session_factory", lambda: _Sess())
    monkeypatch.setattr(
        "agentcore.db.repositories.TurnJournalRepository",
        lambda _db: Repo(),
    )

    found = await list_journal_pending_team_previews("c-ask")
    assert [item[1] for item in found] == ["tp1"]

    sink = EventSink()
    out = await orphan_conversation_team_previews(
        "c-ask", sink=sink, reason="superseded", exclude_ids={"tp_new"}
    )
    assert out == ["tp1"]
    assert [f["kind"] for f in facts] == ["team_preview"]
    assert "ask1" not in {f["interaction_id"] for f in facts}
    assert not any(
        e.payload.get("kind") == "ask_user"
        for e in sink._history
        if e.type is EventType.INTERACTION_ORPHANED
    )


async def test_orphan_exclude_skips_new_card_id(monkeypatch):
    _patch_empty_journal(monkeypatch)
    facts = _patch_orphan_fact(monkeypatch)
    remember_live_team_preview("c-ex", "tp_old", "m1")
    remember_live_team_preview("c-ex", "tp_new", "m1")
    sink = EventSink()
    out = await orphan_conversation_team_previews(
        "c-ex", sink=sink, reason="superseded", exclude_ids={"tp_new"}
    )
    assert out == ["tp_old"]
    assert [f["interaction_id"] for f in facts] == ["tp_old"]


async def test_supersede_failure_does_not_block_persist(monkeypatch):
    _patch_persist_ok(monkeypatch)

    async def _boom(*_a, **_k):
        raise RuntimeError("db down")

    monkeypatch.setattr(
        "agentcore.runtime.kickoff.orphan.orphan_conversation_team_previews",
        _boom,
    )
    sink = EventSink()
    host = _host(sink)
    assert await persist_kickoff(host, "tp1", _summary(), _required("conv-orphan", "tp1"))
    assert any(e.type is EventType.TEAM_PREVIEW_REQUIRED for e in sink._history)


async def test_same_conversation_persist_is_serial(monkeypatch):
    """同会话两张 persist 不能并行进入落盘（gather 双发须互相看得见）。"""
    _patch_empty_journal(monkeypatch)
    _patch_orphan_fact(monkeypatch)
    started: list[str] = []
    first_entered = asyncio.Event()
    release = asyncio.Event()

    async def _gated(**kwargs):
        started.append(str(kwargs.get("checkpoint_id") or ""))
        first_entered.set()
        await release.wait()
        return True

    _patch_persist_ok(monkeypatch, _gated)
    sink = EventSink()
    host = _host(sink)
    summary = _summary()
    first = asyncio.create_task(
        persist_kickoff(host, "tp1", summary, _required("conv-orphan", "tp1"))
    )
    await first_entered.wait()
    second = asyncio.create_task(
        persist_kickoff(host, "tp2", summary, _required("conv-orphan", "tp2"))
    )
    await asyncio.sleep(0.05)
    assert started == ["tp1"]
    release.set()
    assert await first
    assert await second
    assert started == ["tp1", "tp2"]
