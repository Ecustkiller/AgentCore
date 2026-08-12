"""Non-retryable consolidation failures advance memory_synced_at (stop sweeper loops).

Mirrors the abnormal-turn skip posture: deterministic failures drop the window;
retryable AgentCoreError leaves the watermark so the next sweep re-selects.

Retryable failures are layered: shared upstream (rate limit / 5xx / quota) arms a
whole-sweep cooldown and aborts the rest of the batch; conversation-local
retryables (e.g. timeout) only cool down that conversation id.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from agentcore.core.errors import LLMAuthError, LLMRateLimitError, LLMTimeoutError, LLMUpstreamError
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


@pytest.fixture(autouse=True)
def _reset_cooldowns():
    consolidation._reset_failure_cooldowns_for_tests()
    yield
    consolidation._reset_failure_cooldowns_for_tests()


@pytest.mark.asyncio
async def test_nonretryable_failure_advances_watermark_and_exits_pending(monkeypatch):
    state = _wire_failing_consolidate(monkeypatch, fail=LLMAuthError(provider_name="platform"))
    assert _pending(state) == ["c-fail"]

    changed = await consolidation.consolidate_conversation("c-fail")

    assert changed is False
    assert state["synced_at"] == state["latest"]
    assert _pending(state) == []  # next sweep must not re-select
    assert not consolidation._in_shared_failure_cooldown()
    assert "c-fail" not in consolidation._failure_cooldown_until


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
    assert _pending(state) == ["c-fail"]  # next sweep still selects (after cooldown)


class _SpyLogger:
    def __init__(self) -> None:
        self.events: list[str] = []
        self.kwargs: list[dict] = []

    def warning(self, event, **kwargs):
        self.events.append(event)
        self.kwargs.append(kwargs)

    def info(self, event, **kwargs):
        self.events.append(event)
        self.kwargs.append(kwargs)

    def debug(self, event, **kwargs):
        self.events.append(event)
        self.kwargs.append(kwargs)

    def error(self, event, **kwargs):
        self.events.append(event)
        self.kwargs.append(kwargs)


@pytest.mark.asyncio
async def test_nonretryable_emits_window_dropped_event(monkeypatch):
    """Dropped windows get their own event — not buried in consolidation_failed."""
    state = _wire_failing_consolidate(monkeypatch, fail=LLMAuthError(provider_name="platform"))
    spy = _SpyLogger()
    monkeypatch.setattr(consolidation, "logger", spy)

    await consolidation.consolidate_conversation("c-fail")

    assert "memory.consolidation_window_dropped" in spy.events
    assert "memory.consolidation_failed" not in spy.events
    assert "memory.consolidation_backoff" not in spy.events
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
    # Shared upstream also arms sweep backoff (separate event).
    assert "memory.consolidation_backoff" in spy.events
    backoff = spy.kwargs[spy.events.index("memory.consolidation_backoff")]
    assert backoff["scope"] == "sweep"
    assert backoff["reason"] == "upstream_unstable"


@pytest.mark.asyncio
async def test_rate_limit_arms_sweep_backoff_and_aborts_remaining_batch(monkeypatch):
    """限流 → 整轮退避且不再逐会话重烧 (production self-reheat signature)."""
    calls: list[str] = []

    async def _consolidate(cid: str, *, store=None):
        calls.append(cid)
        # First pending hit trips shared upstream; subsequent ids must not run.
        if cid == "c1":
            consolidation._mark_shared_failure_cooldown(reason="rate_limit")
        return False

    class _FakeConvRepo:
        def __init__(self, session):
            pass

        async def list_pending_memory_consolidation(self, *, idle_before, limit):
            return ["c1", "c2", "c3"]

    monkeypatch.setattr(consolidation, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(consolidation, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(consolidation, "consolidate_conversation", _consolidate)
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_base_seconds",
        300,
        raising=True,
    )
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_max_seconds",
        1800,
        raising=True,
    )

    attempted = await consolidation.consolidation_sweep_once()

    assert calls == ["c1"]  # c2/c3 aborted — no per-conversation reburn
    assert attempted == 1
    assert consolidation._in_shared_failure_cooldown()

    # Next sweep while cooldown active: zero attempts.
    calls.clear()
    attempted2 = await consolidation.consolidation_sweep_once()
    assert attempted2 == 0
    assert calls == []


@pytest.mark.asyncio
async def test_rate_limit_via_consolidate_arms_shared_cooldown(monkeypatch):
    state = _wire_failing_consolidate(monkeypatch, fail=LLMRateLimitError())
    spy = _SpyLogger()
    monkeypatch.setattr(consolidation, "logger", spy)
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_base_seconds",
        300,
        raising=True,
    )
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_max_seconds",
        1800,
        raising=True,
    )

    await consolidation.consolidate_conversation("c-fail")

    assert state["synced_at"] is None  # retryable: watermark untouched
    assert consolidation._in_shared_failure_cooldown()
    assert "c-fail" not in consolidation._failure_cooldown_until
    assert "memory.consolidation_backoff" in spy.events
    backoff = spy.kwargs[spy.events.index("memory.consolidation_backoff")]
    assert backoff["scope"] == "sweep"
    assert backoff["reason"] == "rate_limit"
    assert backoff["cooldown_seconds"] == 300.0
    assert backoff["streak"] == 1


@pytest.mark.asyncio
async def test_timeout_arms_conversation_cooldown_not_sweep(monkeypatch):
    state = _wire_failing_consolidate(monkeypatch, fail=LLMTimeoutError("timed out"))
    spy = _SpyLogger()
    monkeypatch.setattr(consolidation, "logger", spy)
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_failure_cooldown_seconds",
        600,
        raising=True,
    )

    await consolidation.consolidate_conversation("c-fail")

    assert state["synced_at"] is None
    assert not consolidation._in_shared_failure_cooldown()
    assert consolidation._in_conversation_failure_cooldown("c-fail")
    backoff = spy.kwargs[spy.events.index("memory.consolidation_backoff")]
    assert backoff["scope"] == "conversation"
    assert backoff["reason"] == "timeout"
    assert backoff["conversation_id"] == "c-fail"

    # Same conversation skipped; cooldown does not block other ids in a sweep.
    assert await consolidation.consolidate_conversation("c-fail") is False


@pytest.mark.asyncio
async def test_conversation_cooldown_skips_one_id_sweep_continues(monkeypatch):
    calls: list[str] = []

    async def _consolidate(cid: str, *, store=None):
        calls.append(cid)
        return False

    class _FakeConvRepo:
        def __init__(self, session):
            pass

        async def list_pending_memory_consolidation(self, *, idle_before, limit):
            return ["c-hot", "c-ok"]

    consolidation._failure_cooldown_until["c-hot"] = __import__("time").monotonic() + 60
    monkeypatch.setattr(consolidation, "async_session_factory", lambda: _FakeSession())
    monkeypatch.setattr(consolidation, "ConversationRepository", _FakeConvRepo)
    monkeypatch.setattr(consolidation, "consolidate_conversation", _consolidate)

    attempted = await consolidation.consolidation_sweep_once()

    assert calls == ["c-ok"]
    assert attempted == 1


@pytest.mark.asyncio
async def test_shared_cooldown_exponential_capped_and_recovers(monkeypatch):
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_base_seconds",
        100,
        raising=True,
    )
    monkeypatch.setattr(
        consolidation.settings,
        "memory_consolidation_shared_failure_cooldown_max_seconds",
        250,
        raising=True,
    )

    consolidation._mark_shared_failure_cooldown(reason="rate_limit")
    assert consolidation._shared_failure_streak == 1
    first_until = consolidation._shared_failure_cooldown_until

    consolidation._mark_shared_failure_cooldown(reason="rate_limit")
    assert consolidation._shared_failure_streak == 2
    # 100 * 2^1 = 200
    assert consolidation._shared_failure_cooldown_until >= first_until

    consolidation._mark_shared_failure_cooldown(reason="rate_limit")
    assert consolidation._shared_failure_streak == 3
    # 100 * 2^2 = 400 capped to 250
    remaining = consolidation._shared_failure_cooldown_until - __import__("time").monotonic()
    assert remaining <= 250.0 + 0.5

    # Success clears streak — recovery path (not permanent off).
    consolidation._clear_shared_failure_cooldown()
    assert consolidation._shared_failure_streak == 0
    assert not consolidation._in_shared_failure_cooldown()


def test_shared_cooldown_expires_lazily(monkeypatch):
    import time

    consolidation._shared_failure_cooldown_until = time.monotonic() - 1
    consolidation._shared_failure_streak = 3
    assert not consolidation._in_shared_failure_cooldown()
    assert consolidation._shared_failure_cooldown_until == 0.0


def test_persistence_defaults_include_consolidation_cooldowns():
    from agentcore.config.persistence import PersistenceSettings

    defaults = PersistenceSettings()
    assert defaults.memory_consolidation_failure_cooldown_seconds == 600
    assert defaults.memory_consolidation_shared_failure_cooldown_base_seconds == 300
    assert defaults.memory_consolidation_shared_failure_cooldown_max_seconds == 1800
