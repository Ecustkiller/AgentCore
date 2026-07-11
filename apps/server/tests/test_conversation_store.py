"""ConversationStore Protocol + D7 merge-rule unit tests."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from agentcore.conversation.store import CloudStore, get_cloud_store
from agentcore.conversation.store import cloud as cloud_mod
from agentcore.conversation.store.merge import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_FAILED,
    MESSAGE_STATUS_INCOMPLETE,
    MESSAGE_STATUS_RUNNING,
    merge_usage_status,
    pick_monotonic_content,
    should_advance_status,
    should_apply_checkpoint_content,
    status_rank,
)
from agentcore.runtime.events import FinishReason
from agentcore.runtime.ports import ConversationStore

pytestmark = pytest.mark.anyio


# --- D7 pure helpers ---


def test_d7_content_monotonic_rejects_shorter_checkpoint():
    assert should_apply_checkpoint_content(
        existing_content="hello world",
        existing_status=MESSAGE_STATUS_RUNNING,
        incoming_content="hello",
    ) is False
    assert should_apply_checkpoint_content(
        existing_content="hello",
        existing_status=MESSAGE_STATUS_RUNNING,
        incoming_content="hello world",
    ) is True


def test_d7_content_monotonic_rejects_terminal_row():
    for status in (
        MESSAGE_STATUS_COMPLETE,
        MESSAGE_STATUS_INCOMPLETE,
        MESSAGE_STATUS_FAILED,
    ):
        assert should_apply_checkpoint_content(
            existing_content="partial",
            existing_status=status,
            incoming_content="partial and more",
        ) is False


def test_d7_status_gate_only_advances():
    assert should_advance_status(MESSAGE_STATUS_RUNNING, MESSAGE_STATUS_COMPLETE)
    assert should_advance_status(MESSAGE_STATUS_RUNNING, MESSAGE_STATUS_FAILED)
    assert not should_advance_status(MESSAGE_STATUS_COMPLETE, MESSAGE_STATUS_RUNNING)
    assert not should_advance_status(MESSAGE_STATUS_COMPLETE, MESSAGE_STATUS_INCOMPLETE)
    assert status_rank(MESSAGE_STATUS_COMPLETE) > status_rank(MESSAGE_STATUS_RUNNING)


def test_d7_merge_usage_status_keeps_terminal():
    merged = merge_usage_status(
        {"status": MESSAGE_STATUS_COMPLETE, "input_tokens": 10},
        {"status": MESSAGE_STATUS_RUNNING, "input_tokens": 12},
    )
    assert merged["status"] == MESSAGE_STATUS_COMPLETE
    assert merged["input_tokens"] == 12


def test_d7_pick_monotonic_content_prefers_longer():
    assert pick_monotonic_content("short", "much longer text") == "much longer text"
    assert pick_monotonic_content("already long enough", "short") == "already long enough"


# --- Protocol shape ---


def test_cloud_store_satisfies_conversation_store_protocol():
    store = CloudStore()
    assert isinstance(store, ConversationStore)
    assert get_cloud_store() is get_cloud_store()


async def test_begin_turn_creates_placeholder(monkeypatch):
    calls: list[dict] = []

    class Repo:
        def __init__(self, _s):
            pass

        async def create_assistant_placeholder(self, **kw):
            calls.append(kw)
            return SimpleNamespace(id=kw["message_id"])

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", Repo)

    await CloudStore().begin_turn(
        conversation_id="c1", message_id="m1", trace_id="t" * 32
    )
    assert calls == [
        {"conversation_id": "c1", "message_id": "m1", "trace_id": "t" * 32}
    ]


async def test_checkpoint_delegates_to_message_repo(monkeypatch):
    calls: list[dict] = []

    class Repo:
        def __init__(self, _s):
            pass

        async def update_assistant_content(self, **kw):
            calls.append(kw)

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", Repo)

    await CloudStore().checkpoint(conversation_id="c1", message_id="m1", content="hi")
    assert calls == [{"conversation_id": "c1", "message_id": "m1", "content": "hi"}]


async def test_append_journal_uses_telemetry_pool(monkeypatch):
    used: list[str] = []
    appended: list[dict] = []

    class CM:
        async def __aenter__(self):
            used.append("telemetry")
            return object()

        async def __aexit__(self, *_a):
            return False

    class Repo:
        def __init__(self, _s):
            pass

        async def append(self, **kw) -> int | None:
            appended.append(kw)
            return 0

    def primary_boom():
        used.append("primary")
        raise AssertionError("append_journal must not use primary pool")

    monkeypatch.setattr(cloud_mod, "telemetry_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "async_session_factory", primary_boom)
    monkeypatch.setattr(cloud_mod, "TurnJournalRepository", Repo)
    monkeypatch.setattr(
        "agentcore.runtime.audit.hooks.on_journal_fact_appended", lambda _e: None
    )

    await CloudStore().append_journal(
        turn_id="m1",
        seq=0,
        conversation_id="c1",
        trace_id="t",
        entry={"kind": "run_plan", "payload": {}},
    )
    assert used == ["telemetry"]
    assert appended[0]["seq"] == 0


async def test_append_journal_skips_hook_on_duplicate(monkeypatch):
    hooks: list[Any] = []

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    class Repo:
        def __init__(self, _s):
            pass

        async def append(self, **_kw) -> int | None:
            return None  # conflict / already present

    monkeypatch.setattr(cloud_mod, "telemetry_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "TurnJournalRepository", Repo)
    monkeypatch.setattr(
        "agentcore.runtime.audit.hooks.on_journal_fact_appended",
        lambda e: hooks.append(e),
    )

    await CloudStore().append_journal(
        turn_id="m1",
        seq=0,
        conversation_id="c1",
        trace_id="t",
        entry={"kind": "x"},
    )
    assert hooks == []


async def test_finalize_local_fills_journal_via_persist(monkeypatch):
    """D7: finalize(mode=local) upserts full journal (no early-return)."""
    journal_calls: list[dict] = []

    class MsgRepo:
        def __init__(self, _s):
            pass

        async def get_by_id(self, *_a, **_k):
            return None

        async def create(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def upsert_assistant(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def user_message_for_assistant(self, **_k):
            return None

        async def set_followups(self, *_a, **_k):
            pass

    class ConvRepo:
        def __init__(self, _s):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title="t")

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    async def fake_persist(_session, **kw):
        journal_calls.append(kw)

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", MsgRepo)
    monkeypatch.setattr(cloud_mod, "ConversationRepository", ConvRepo)
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", fake_persist)
    monkeypatch.setattr(cloud_mod, "schedule_consolidation", lambda _c: None)
    monkeypatch.setattr(
        cloud_mod, "build_provider", lambda *_a, **_k: SimpleNamespace(close=AsyncMock())
    )
    monkeypatch.setattr(cloud_mod, "resolve_user_model", lambda *_a, **_k: "m")
    monkeypatch.setattr(cloud_mod, "mint_followups", AsyncMock(return_value=[]))

    result = await CloudStore().finalize(
        mode="local",
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="done",
        runs={"events": [{"type": "run_plan", "payload": {}}], "finish_reason": "end_turn"},
        user_message_id="u1m",
        message_id="m1",
        trace_id="t" * 32,
    )
    assert result is not None
    assert result["assistant_message_id"] == "m1"
    assert len(journal_calls) == 1
    assert journal_calls[0]["message_id"] == "m1"


async def test_finalize_local_persists_raw_journal_when_runs_missing(monkeypatch):
    """Crash salvage: runs=None → persist outbox journal facts directly."""
    journal_calls: list[dict] = []
    upserted: dict = {}

    class MsgRepo:
        def __init__(self, _s):
            pass

        async def get_by_id(self, *_a, **_k):
            return None

        async def create(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def upsert_assistant(self, **kw):
            upserted.update(kw)
            return SimpleNamespace(id=kw["message_id"])

        async def user_message_for_assistant(self, **_k):
            return None

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    async def fake_persist(_session, **kw):
        journal_calls.append(kw)

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", MsgRepo)
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", fake_persist)

    facts = [
        {"kind": "run_started", "payload": {"id": "r1"}, "ts": "t0"},
        {"kind": "run_completed", "payload": {"id": "r1"}, "ts": None},
    ]
    result = await CloudStore().finalize(
        mode="local",
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="partial",
        runs=None,
        journal=facts,
        user_message_id="u1m",
        message_id="m1",
        trace_id="t" * 32,
        finish_reason=FinishReason.CANCELLED.value,
    )
    assert result is not None
    assert result["assistant_message_id"] == "m1"
    assert upserted["metadata"]["status"] == MESSAGE_STATUS_INCOMPLETE
    assert upserted["metadata"]["incomplete"] is True
    assert upserted["metadata"]["finish_reason"] == "cancelled"
    assert "连接中断" in upserted["content"]
    assert len(journal_calls) == 1
    assert journal_calls[0]["entries"] == facts


async def test_finalize_local_mints_followups(monkeypatch):
    """Local finalize (non-skip_derived) persists followups like cloud (no SSE)."""
    followup_calls: list[dict] = []

    class MsgRepo:
        def __init__(self, _s):
            pass

        async def get_by_id(self, *_a, **_k):
            return None

        async def create(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def upsert_assistant(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def user_message_for_assistant(self, **_k):
            return None

        async def set_followups(self, message_id, *, conversation_id, followups):
            followup_calls.append(
                {
                    "message_id": message_id,
                    "conversation_id": conversation_id,
                    "followups": followups,
                }
            )

    class ConvRepo:
        def __init__(self, _s):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title="already")

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", MsgRepo)
    monkeypatch.setattr(cloud_mod, "ConversationRepository", ConvRepo)
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", AsyncMock())
    monkeypatch.setattr(cloud_mod, "schedule_consolidation", lambda _c: None)
    monkeypatch.setattr(
        cloud_mod, "build_provider", lambda *_a, **_k: SimpleNamespace(close=AsyncMock())
    )
    monkeypatch.setattr(cloud_mod, "resolve_user_model", lambda *_a, **_k: "m")
    monkeypatch.setattr(
        cloud_mod, "mint_followups", AsyncMock(return_value=["下一步 A", "下一步 B"])
    )

    result = await CloudStore().finalize(
        mode="local",
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="done reply",
        runs={"events": [], "finish_reason": "end_turn"},
        user_message_id="u1m",
        message_id="m1",
        trace_id="t" * 32,
        finish_reason=FinishReason.END_TURN.value,
    )
    assert result is not None
    assert followup_calls == [
        {
            "message_id": "m1",
            "conversation_id": "c1",
            "followups": ["下一步 A", "下一步 B"],
        }
    ]
    assert result["followups"] == ["下一步 A", "下一步 B"]


async def test_finalize_local_skips_followups_when_not_end_turn(monkeypatch):
    """Positive gate: only end_turn + non-empty body mints; degraded/etc. do not."""
    followup_calls: list[dict] = []
    mint = AsyncMock(return_value=["不应出现"])

    class MsgRepo:
        def __init__(self, _s):
            pass

        async def get_by_id(self, *_a, **_k):
            return None

        async def create(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def upsert_assistant(self, **kw):
            return SimpleNamespace(id=kw["message_id"])

        async def user_message_for_assistant(self, **_k):
            return None

        async def set_followups(self, message_id, *, conversation_id, followups):
            followup_calls.append(
                {
                    "message_id": message_id,
                    "conversation_id": conversation_id,
                    "followups": followups,
                }
            )

    class ConvRepo:
        def __init__(self, _s):
            pass

        async def get_by_id_unscoped(self, _cid):
            return SimpleNamespace(title="already")

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", MsgRepo)
    monkeypatch.setattr(cloud_mod, "ConversationRepository", ConvRepo)
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", AsyncMock())
    monkeypatch.setattr(cloud_mod, "schedule_consolidation", lambda _c: None)
    monkeypatch.setattr(
        cloud_mod, "build_provider", lambda *_a, **_k: SimpleNamespace(close=AsyncMock())
    )
    monkeypatch.setattr(cloud_mod, "resolve_user_model", lambda *_a, **_k: "m")
    monkeypatch.setattr(cloud_mod, "mint_followups", mint)

    result = await CloudStore().finalize(
        mode="local",
        conversation_id="c1",
        user_id="u1",
        user_message="hi",
        assistant_content="partial reply",
        runs={"events": [], "finish_reason": "degraded"},
        user_message_id="u1m",
        message_id="m1",
        trace_id="t" * 32,
        finish_reason=FinishReason.DEGRADED.value,
    )
    assert result is not None
    assert followup_calls == []
    assert mint.await_count == 0
    assert result["followups"] is None


async def test_persist_turn_journal_upserts_by_seq(monkeypatch):
    """D7: finalize full journal fills holes via seq upsert (no length heuristic)."""
    from agentcore.runtime.journal.persist import persist_turn_journal

    appended: list[int] = []

    class Repo:
        def __init__(self, _s):
            pass

        async def append(self, *, turn_id, seq, conversation_id, trace_id, entry) -> int | None:
            appended.append(seq)
            return seq if seq is not None else 0

    class Session:
        async def rollback(self):
            pass

    monkeypatch.setattr("agentcore.db.repositories.TurnJournalRepository", Repo)
    monkeypatch.setattr(
        "agentcore.config.settings.observability_span_export_enabled", False
    )

    entries = [
        {"kind": "run_plan", "payload": {}},
        {"kind": "run_completed", "payload": {}},
        {"kind": "turn_end", "payload": {"finish_reason": "end_turn"}},
    ]
    await persist_turn_journal(
        Session(),  # type: ignore[arg-type]
        message_id="m1",
        conversation_id="c1",
        trace_id="t",
        entries=entries,
    )
    assert appended == [0, 1, 2]


async def test_salvage_writes_incomplete_status(monkeypatch):
    upserted: dict = {}

    class MsgRepo:
        def __init__(self, _s):
            pass

        async def upsert_assistant(self, **kw):
            upserted.update(kw)
            return SimpleNamespace(id=kw["message_id"])

    class CM:
        async def __aenter__(self):
            return object()

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: CM())
    monkeypatch.setattr(cloud_mod, "MessageRepository", MsgRepo)
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", AsyncMock())

    await CloudStore().salvage(
        journal=[],
        content="partial reply",
        conversation_id="c1",
        trace_id="t" * 32,
        message_id="m1",
    )
    assert upserted["metadata"]["status"] == MESSAGE_STATUS_INCOMPLETE
    assert "partial reply" in upserted["content"]
