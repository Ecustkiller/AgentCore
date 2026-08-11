"""Non-retryable consolidation failures advance memory_synced_at (stop sweeper loops).

Mirrors the abnormal-turn skip posture: deterministic failures drop the window;
retryable AgentCoreError leaves the watermark so the next sweep re-selects.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from agentcore.core.errors import LLMAuthError, LLMUpstreamError
from agentcore.memory import consolidation


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _wire_failing_consolidate(monkeypatch, *, fail: BaseException) -> dict:
    """Point consolidate_conversation at in-memory fakes; LLM path raises ``fail``.

    Returns a recorder with ``synced_at`` (watermark writes) and helpers for the
    sweeper pending predicate used by ``list_pending_memory_consolidation``.
    """
    latest = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    idle_before = latest + timedelta(seconds=1)
    state: dict = {
        "synced_at": None,
        "latest": latest,
        "idle_before": idle_before,
        "conv_id": "c-fail",
    }

    @asynccontextmanager
    async def _lock(_conversation_id: str):
        yield "u-fail"

    monkeypatch.setattr(consolidation, "user_memory_lock_for", _lock)
    monkeypatch.setattr(consolidation, "async_session_factory", lambda: _FakeSession())

    class _FakeMsgRepo:
        def __init__(self, session):
            pass

        async def latest_created_at(self, conversation_id):
            return state["latest"]

    class _FakeConvRepo:
        def __init__(self, session):
            pass

        async def get_by_id_unscoped(self, conversation_id):
            return SimpleNamespace(
                id=conversation_id,
                folder_id=None,
                memory_synced_at=state["synced_at"],
            )

        async def set_memory_synced_at(self, conversation_id, synced_at):
            assert conversation_id == state["conv_id"]
            state["synced_at"] = synced_at

        async def list_pending_memory_consolidation(self, *, idle_before, limit):
            # Same predicate as ConversationRepository.list_pending_memory_consolidation:
            # latest > coalesce(synced_at, epoch) AND latest <= idle_before.
            epoch = datetime(1970, 1, 1, tzinfo=UTC)
            synced = state["synced_at"] if state["synced_at"] is not None else epoch
            if state["latest"] > synced and state["latest"] <= idle_before:
                return [state["conv_id"]]
            return []

    async def _turn_open(_session, _cid):
        return False

    async def _assistant_row(_session, _cid):
        return (
            {"status": "complete", "finish_reason": "end_turn"},
            "正文",
            True,
        )

    async def _history(_session, _cid, *, max_messages):
        return [
            SimpleNamespace(role="user", content="hi"),
            SimpleNamespace(role="assistant", content="正文"),
        ]

    async def _actions(_session, _cid, *, max_turns):
        return None

    async def _run_bg(user_id, *, purpose="memory", runner):
        raise fail

    monkeypatch.setattr(consolidation, "MessageRepository", _FakeMsgRepo)
    monkeypatch.setattr(consolidation, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(consolidation, "conversation_turn_open", _turn_open)
    monkeypatch.setattr(consolidation, "_latest_assistant_row", _assistant_row)
    monkeypatch.setattr(consolidation, "load_recent_history", _history)
    monkeypatch.setattr(consolidation, "_load_conversation_action_inventory", _actions)
    monkeypatch.setattr(consolidation, "run_background_llm", _run_bg)
    return state


def _pending(state: dict) -> list[str]:
    """In-memory sweeper selection matching the repo HAVING clause."""
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    synced = state["synced_at"] if state["synced_at"] is not None else epoch
    if state["latest"] > synced and state["latest"] <= state["idle_before"]:
        return [state["conv_id"]]
    return []


@pytest.mark.asyncio
async def test_nonretryable_failure_advances_watermark_and_exits_pending(monkeypatch):
    state = _wire_failing_consolidate(monkeypatch, fail=LLMAuthError(provider_name="platform"))
    assert _pending(state) == ["c-fail"]

    changed = await consolidation.consolidate_conversation("c-fail")

    assert changed is False
    assert state["synced_at"] == state["latest"]
    assert _pending(state) == []  # next sweep must not re-select


@pytest.mark.asyncio
async def test_bare_exception_advances_watermark_and_exits_pending(monkeypatch):
    """AttributeError-class bugs have no retryable flag but are deterministic."""
    state = _wire_failing_consolidate(monkeypatch, fail=AttributeError("'NoneType' object"))
    assert _pending(state) == ["c-fail"]

    changed = await consolidation.consolidate_conversation("c-fail")

    assert changed is False
    assert state["synced_at"] == state["latest"]
    assert _pending(state) == []


@pytest.mark.asyncio
async def test_retryable_failure_keeps_watermark_and_stays_pending(monkeypatch):
    state = _wire_failing_consolidate(
        monkeypatch, fail=LLMUpstreamError("502", upstream_status=502)
    )
    assert _pending(state) == ["c-fail"]

    changed = await consolidation.consolidate_conversation("c-fail")

    assert changed is False
    assert state["synced_at"] is None
    assert _pending(state) == ["c-fail"]  # next sweep still selects


class _SpyLogger:
    def __init__(self) -> None:
        self.events: list[str] = []

    def warning(self, event, **_kwargs):
        self.events.append(event)

    def info(self, event, **_kwargs):
        self.events.append(event)

    def debug(self, event, **_kwargs):
        self.events.append(event)

    def error(self, event, **_kwargs):
        self.events.append(event)


@pytest.mark.asyncio
async def test_nonretryable_emits_window_dropped_event(monkeypatch):
    """Dropped windows get their own event — not buried in consolidation_failed."""
    state = _wire_failing_consolidate(monkeypatch, fail=LLMAuthError(provider_name="platform"))
    spy = _SpyLogger()
    monkeypatch.setattr(consolidation, "logger", spy)

    await consolidation.consolidate_conversation("c-fail")

    assert "memory.consolidation_window_dropped" in spy.events
    assert "memory.consolidation_failed" not in spy.events
    assert state["synced_at"] == state["latest"]


@pytest.mark.asyncio
async def test_retryable_emits_consolidation_failed_only(monkeypatch):
    state = _wire_failing_consolidate(
        monkeypatch, fail=LLMUpstreamError("502", upstream_status=502)
    )
    spy = _SpyLogger()
    monkeypatch.setattr(consolidation, "logger", spy)

    await consolidation.consolidate_conversation("c-fail")

    assert "memory.consolidation_failed" in spy.events
    assert "memory.consolidation_window_dropped" not in spy.events
    assert state["synced_at"] is None
