"""Unit tests for disconnect-salvage of a turn's finished work (断线别白干).

A turn cancelled mid-flight (client disconnect / user stop / pending approval) used
to discard workers that had ALREADY finished. The salvage path persists that finished
work as one "incomplete" assistant message instead. These cover:

- ``_has_open_durable_pause`` — which journals count as a live resume frame (so salvage
  defers to ``POST .../resume`` rather than double-handling the turn);
- ``_salvage_incomplete_turn`` — the spawn decision (gate / empty journal / durable
  pause deferral vs. fire);
- ``_persist_incomplete_turn`` — the persisted message shape (cancelled flag, journal,
  no ledger).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from agentcore.config import settings
from agentcore.conversation import service, turn_persistence
from agentcore.runtime.events import FinishReason


def _ev(type_: str, checkpoint_id: str | None = None) -> dict:
    payload = {"checkpoint_id": checkpoint_id} if checkpoint_id else {}
    return {"type": type_, "payload": payload}


class _Sink:
    """Minimal stand-in for EventSink — only ``execution_journal`` is read here."""

    def __init__(self, journal: list[dict] | None) -> None:
        self._journal = journal

    def execution_journal(self) -> list[dict] | None:
        return self._journal


# --- _has_open_durable_pause ---


def test_open_pause_false_on_empty_journal():
    assert service._has_open_durable_pause([]) is False


def test_open_pause_true_on_unresolved_checkpoint():
    assert service._has_open_durable_pause([_ev("checkpoint_required", "c1")]) is True


def test_open_pause_true_on_unresolved_plan_review():
    assert service._has_open_durable_pause([_ev("plan_review_required", "p1")]) is True


def test_open_pause_false_when_resolved():
    journal = [_ev("checkpoint_required", "c1"), _ev("checkpoint_resolved", "c1")]
    assert service._has_open_durable_pause(journal) is False


def test_open_pause_false_for_delegation_only():
    # A team graph with no journaled checkpoint (e.g. an approval pause — approvals are
    # transport-only, never journaled) is NOT a durable pause: salvage should cover it.
    journal = [_ev("run_plan"), _ev("run_started"), _ev("run_completed")]
    assert service._has_open_durable_pause(journal) is False


# --- _salvage_incomplete_turn (spawn decision) ---


@pytest.fixture
def capture(monkeypatch):
    """Patch the persist + spawn seam so the decision is observable without a DB."""
    spawned: list = []
    persist_calls: list[dict] = []

    def fake_persist(**kwargs):
        persist_calls.append(kwargs)
        return MagicMock(name="persist_coro")  # not awaited (spawn is faked)

    def fake_spawn(coro):
        spawned.append(coro)
        return MagicMock(name="task")

    monkeypatch.setattr(turn_persistence, "persist_incomplete_turn", fake_persist)
    monkeypatch.setattr(turn_persistence, "spawn_background", fake_spawn)
    return spawned, persist_calls


def test_salvage_spawns_on_finished_work(monkeypatch, capture):
    spawned, persist_calls = capture
    monkeypatch.setattr(settings, "incomplete_turn_persist_enabled", True)
    journal = [_ev("run_plan"), _ev("run_completed")]
    service._salvage_incomplete_turn(sink=_Sink(journal), conversation_id="conv", trace_id="trace")
    assert len(spawned) == 1
    assert persist_calls[0]["conversation_id"] == "conv"
    assert persist_calls[0]["trace_id"] == "trace"
    assert persist_calls[0]["journal"] == journal


def test_salvage_skips_when_gate_off(monkeypatch, capture):
    spawned, _ = capture
    monkeypatch.setattr(settings, "incomplete_turn_persist_enabled", False)
    service._salvage_incomplete_turn(
        sink=_Sink([_ev("run_plan")]), conversation_id="conv", trace_id="trace"
    )
    assert spawned == []


def test_salvage_skips_when_no_journal(monkeypatch, capture):
    spawned, _ = capture
    monkeypatch.setattr(settings, "incomplete_turn_persist_enabled", True)
    service._salvage_incomplete_turn(sink=_Sink(None), conversation_id="conv", trace_id="trace")
    assert spawned == []


def test_salvage_defers_to_resume_on_durable_pause(monkeypatch, capture):
    spawned, _ = capture
    monkeypatch.setattr(settings, "incomplete_turn_persist_enabled", True)
    monkeypatch.setattr(settings, "structured_suspension_persist_enabled", True)
    journal = [_ev("run_plan"), _ev("plan_review_required", "p1")]
    service._salvage_incomplete_turn(sink=_Sink(journal), conversation_id="conv", trace_id="trace")
    assert spawned == []  # a paused_turns frame owns this turn's continuation


def test_salvage_runs_on_pause_when_persistence_disabled(monkeypatch, capture):
    spawned, _ = capture
    monkeypatch.setattr(settings, "incomplete_turn_persist_enabled", True)
    monkeypatch.setattr(settings, "structured_suspension_persist_enabled", False)
    # No durable frame exists (2a in-memory only) ⇒ salvage the finished work instead.
    journal = [_ev("run_plan"), _ev("plan_review_required", "p1")]
    service._salvage_incomplete_turn(sink=_Sink(journal), conversation_id="conv", trace_id="trace")
    assert len(spawned) == 1


# --- _persist_incomplete_turn (persisted shape) ---


async def test_persist_incomplete_writes_cancelled_message(monkeypatch):
    created: dict = {}
    journaled: dict = {}

    class FakeRepo:
        def __init__(self, _session):
            pass

        async def create(self, **kwargs):
            created.update(kwargs)
            return SimpleNamespace(id=kwargs.get("message_id") or "generated")

    class FakeSessionCM:
        async def __aenter__(self):
            return SimpleNamespace()

        async def __aexit__(self, *_a):
            return False

    async def fake_journal(_session, **kwargs):
        journaled.update(kwargs)

    monkeypatch.setattr(turn_persistence, "MessageRepository", FakeRepo)
    monkeypatch.setattr(turn_persistence, "async_session_factory", lambda: FakeSessionCM())
    monkeypatch.setattr(turn_persistence, "persist_turn_journal", fake_journal)

    journal = [_ev("run_plan"), _ev("run_completed")]
    await service._persist_incomplete_turn(
        journal=journal, conversation_id="conv", trace_id="trace", message_id="m1"
    )

    assert created["role"] == "assistant"
    assert created["content"]  # a non-empty explanatory note
    # The replay payload is no longer stored on the message — it goes to the唯一事实源
    # turn_journal, keyed by the created assistant id (§18.3).
    assert "runs" not in created
    assert created["metadata"]["incomplete"] is True
    assert created["metadata"]["finish_reason"] == FinishReason.CANCELLED.value
    assert created["message_id"] == "m1"
    assert created["trace_id"] == "trace"
    # The cancelled turn's finished team work is recorded to the journal.
    assert journaled["message_id"] == "m1"
    assert journaled["runs"]["events"] == journal
    assert journaled["runs"]["finish_reason"] == FinishReason.CANCELLED.value


async def test_persist_incomplete_swallows_db_errors(monkeypatch):
    class BoomCM:
        async def __aenter__(self):
            raise RuntimeError("db down")

        async def __aexit__(self, *_a):
            return False

    monkeypatch.setattr(turn_persistence, "async_session_factory", lambda: BoomCM())
    # Best-effort (文档铁律): a persistence failure must never escape this task.
    await service._persist_incomplete_turn(
        journal=[_ev("run_plan")],
        conversation_id="conv",
        trace_id="trace",
        message_id=None,
    )
