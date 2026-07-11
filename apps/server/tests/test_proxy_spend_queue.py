"""proxy_spend durable queue: drain, idempotent run_id dedupe, telemetry pool isolation."""

from __future__ import annotations

import json

import pytest

from agentcore.billing import proxy_spend_queue as queue_mod
from agentcore.llm.provider.protocol import TokenUsage


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _usage() -> TokenUsage:
    return TokenUsage(input_tokens=10, output_tokens=2)


@pytest.fixture
def spend_queue(monkeypatch, tmp_path):
    queue = queue_mod.reset_proxy_spend_queue_for_tests()
    monkeypatch.setattr(queue_mod.settings, "data_dir", str(tmp_path))
    return queue


async def test_enqueue_writes_disk_then_drain_records(monkeypatch, spend_queue, tmp_path):
    calls: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            calls.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    rid = spend_queue.enqueue(
        user_id="u1",
        conversation_id="c1",
        model="deepseek-v4-flash",
        usage=_usage(),
        message_id="m1",
        trace_id="t1",
    )
    assert rid is not None
    files = list((tmp_path / "telemetry" / "proxy_spend_queue").glob("*.json"))
    assert len(files) == 1

    assert await spend_queue.drain_once() == 1
    assert calls and calls[0]["message_id"] == "m1"
    assert calls[0]["runs"][0]["run_id"]
    # Acked — file gone.
    assert list((tmp_path / "telemetry" / "proxy_spend_queue").glob("*.json")) == []


async def test_drain_retry_same_run_id_no_double_bill(monkeypatch, spend_queue, tmp_path):
    """At-least-once: re-draining the same record must reuse run_id (ledger dedupes)."""
    seen_run_ids: list[str] = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            seen_run_ids.append(kw["runs"][0]["run_id"])
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    spend_queue.enqueue(
        user_id="u1",
        conversation_id="c1",
        model="m",
        usage=_usage(),
    )
    qdir = tmp_path / "telemetry" / "proxy_spend_queue"
    files = list(qdir.glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    run_id = payload["runs"][0]["run_id"]

    # Simulate: DB write succeeded but ack (unlink) failed — file still present.
    # First drain would normally delete; instead we call record path twice manually
    # by re-writing the file after a successful drain... simpler: drain once, then
    # put the same payload back and drain again — run_id must be identical.
    assert await spend_queue.drain_once() == 1
    assert seen_run_ids == [run_id]

    # Re-drop the same durable record (crash between commit and unlink).
    files[0].write_text(json.dumps(payload), encoding="utf-8")
    assert await spend_queue.drain_once() == 1
    assert seen_run_ids == [run_id, run_id]  # same key twice → ON CONFLICT DO NOTHING


async def test_survives_process_restart_via_disk(monkeypatch, spend_queue, tmp_path):
    """Files left on disk after a crash are drained by a fresh queue instance."""
    calls: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            calls.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    spend_queue.enqueue(
        user_id="u1",
        conversation_id="c1",
        model="m",
        usage=_usage(),
    )
    # New process = new queue singleton; disk still has the file.
    restarted = queue_mod.reset_proxy_spend_queue_for_tests()
    monkeypatch.setattr(queue_mod.settings, "data_dir", str(tmp_path))
    assert await restarted.drain_once() == 1
    assert len(calls) == 1


async def test_journal_uses_telemetry_pool_not_primary(monkeypatch):
    """Journal drain must check out the telemetry factory (pool isolation)."""
    from agentcore.runtime.journal.writer import TurnJournalWriter

    used: list[str] = []

    class Tracker:
        def factory(self):
            used.append("telemetry")
            return _FakeSession()

    class Repo:
        def __init__(self, _session):
            pass

        async def append(self, **_kw):
            return None

    def primary_boom():
        used.append("primary")
        raise AssertionError("journal must not use the primary pool")

    monkeypatch.setattr(
        "agentcore.conversation.store.cloud.telemetry_session_factory", Tracker().factory
    )
    monkeypatch.setattr("agentcore.conversation.store.cloud.async_session_factory", primary_boom)
    monkeypatch.setattr("agentcore.conversation.store.cloud.TurnJournalRepository", Repo)
    monkeypatch.setattr(
        "agentcore.runtime.audit.hooks.on_journal_fact_appended", lambda entry: None
    )

    writer = TurnJournalWriter(turn_id="m1", conversation_id="c1", trace_id="t1")
    fut = writer.schedule_append({"kind": "k"})
    await writer.flush()
    assert fut is not None and fut.done()
    assert used == ["telemetry"]
