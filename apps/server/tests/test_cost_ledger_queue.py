"""Shared cost ledger durable queue: turn/handoff enqueue + drain."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from agentcore.billing import cost_ledger_queue as queue_mod


class _FakeSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


@pytest.fixture
def ledger_queue(monkeypatch, tmp_path):
    queue = queue_mod.reset_cost_ledger_queue_for_tests()
    monkeypatch.setattr(queue_mod.settings, "data_dir", str(tmp_path))
    return queue


def _sample_runs(*, run_id: str = "run-1") -> list[dict]:
    return [
        {
            "run_id": run_id,
            "agent_id": "CEO",
            "role": "captain",
            "model": "m",
            "tokens": {"input": 1, "output": 2},
            "cost": {},
            "cost_total_nano": 0,
            "currency": "USD",
            "rounds": 1,
            "duration_ms": 10,
        }
    ]


async def test_enqueue_runs_then_drain_records(monkeypatch, ledger_queue, tmp_path):
    calls: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            calls.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    rid = ledger_queue.enqueue_runs(
        user_id="u1",
        conversation_id="c1",
        message_id="m1",
        trace_id="t1",
        runs=_sample_runs(),
        source="turn",
    )
    assert rid is not None
    files = list((tmp_path / "telemetry" / "cost_ledger_queue").glob("*.json"))
    assert len(files) == 1
    payload = json.loads(files[0].read_text(encoding="utf-8"))
    assert payload["source"] == "turn"
    assert payload["runs"][0]["run_id"] == "run-1"

    assert await ledger_queue.drain_once() == 1
    assert calls and calls[0]["message_id"] == "m1"
    assert calls[0]["runs"][0]["run_id"] == "run-1"
    assert list((tmp_path / "telemetry" / "cost_ledger_queue").glob("*.json")) == []


async def test_drain_retries_after_write_failure(monkeypatch, ledger_queue, tmp_path):
    """Sync write failed → enqueue; first drain fails; second drain succeeds."""
    attempts = {"n": 0}
    calls: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise RuntimeError("db down")
            calls.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    ledger_queue.enqueue_runs(
        user_id="u1",
        conversation_id="c1",
        message_id="m1",
        runs=_sample_runs(run_id="run-retry"),
        source="handoff",
    )
    assert await ledger_queue.drain_once() == 0
    assert list((tmp_path / "telemetry" / "cost_ledger_queue").glob("*.json"))
    assert calls == []

    assert await ledger_queue.drain_once() == 1
    assert calls[0]["runs"][0]["run_id"] == "run-retry"
    assert list((tmp_path / "telemetry" / "cost_ledger_queue").glob("*.json")) == []


async def test_drains_legacy_proxy_spend_dir(monkeypatch, ledger_queue, tmp_path):
    """Files left in the old proxy_spend_queue path are still consumed."""
    calls: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            calls.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    legacy = tmp_path / "telemetry" / "proxy_spend_queue"
    legacy.mkdir(parents=True)
    (legacy / "legacy.json").write_text(
        json.dumps(
            {
                "id": "legacy-1",
                "user_id": "u1",
                "conversation_id": "c1",
                "runs": _sample_runs(run_id="legacy-run"),
            }
        ),
        encoding="utf-8",
    )
    assert await ledger_queue.drain_once() == 1
    assert calls[0]["runs"][0]["run_id"] == "legacy-run"


async def test_oserror_on_read_leaves_file_for_retry(monkeypatch, ledger_queue, tmp_path):
    """Transient OSError must not quarantine to .corrupt (leave for retry)."""
    qdir = tmp_path / "telemetry" / "cost_ledger_queue"
    qdir.mkdir(parents=True)
    path = qdir / "transient.json"
    path.write_text(
        json.dumps(
            {
                "id": "t1",
                "user_id": "u1",
                "conversation_id": "c1",
                "runs": _sample_runs(run_id="run-os"),
            }
        ),
        encoding="utf-8",
    )

    real_read = Path.read_text
    calls = {"n": 0}

    def flaky_read(self, *args, **kwargs):
        if self == path and calls["n"] == 0:
            calls["n"] += 1
            raise OSError("simulated share violation")
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", flaky_read)

    assert await ledger_queue.drain_once() == 0
    assert path.exists()
    assert list(qdir.glob("*.corrupt")) == []

    # Second attempt succeeds after OSError clears.
    written: list = []

    class Repo:
        def __init__(self, _session):
            pass

        async def record_runs(self, **kw):
            written.append(kw)
            return 1

    monkeypatch.setattr("agentcore.db.base.telemetry_session_factory", lambda: _FakeSession())
    monkeypatch.setattr("agentcore.db.repositories.CostEventRepository", Repo)

    assert await ledger_queue.drain_once() == 1
    assert written[0]["runs"][0]["run_id"] == "run-os"
    assert not path.exists()


async def test_bad_json_still_quarantines(ledger_queue, tmp_path):
    """Malformed JSON remains poison → .corrupt, never retried as valid."""
    qdir = tmp_path / "telemetry" / "cost_ledger_queue"
    qdir.mkdir(parents=True)
    path = qdir / "bad.json"
    path.write_text("{not-json", encoding="utf-8")

    assert await ledger_queue.drain_once() == 0
    assert not path.exists()
    corrupt = list(qdir.glob("*.corrupt"))
    assert len(corrupt) == 1
    assert corrupt[0].read_text(encoding="utf-8") == "{not-json"


async def test_invalid_payload_still_quarantines(ledger_queue, tmp_path):
    """Valid JSON missing required fields still quarantines."""
    qdir = tmp_path / "telemetry" / "cost_ledger_queue"
    qdir.mkdir(parents=True)
    path = qdir / "invalid.json"
    path.write_text(
        json.dumps({"id": "x", "user_id": "u1", "runs": [], "calls": []}),
        encoding="utf-8",
    )

    assert await ledger_queue.drain_once() == 0
    assert not path.exists()
    assert list(qdir.glob("*.corrupt"))


async def test_stop_cancels_before_final_drain(monkeypatch, ledger_queue, tmp_path):
    """stop: cancel loop first, then single-threaded final drain (no stop∩loop race)."""
    order: list[str] = []
    barrier = asyncio.Event()

    async def slow_drain_loop():
        order.append("loop_enter")
        barrier.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            order.append("loop_cancelled")
            raise

    async def tracking_drain_once():
        order.append("final_drain")
        return 0

    ledger_queue._task = asyncio.create_task(slow_drain_loop(), name="cost_ledger_drain")
    await barrier.wait()
    monkeypatch.setattr(ledger_queue, "drain_once", tracking_drain_once)

    await ledger_queue.stop()

    assert order == ["loop_enter", "loop_cancelled", "final_drain"]
    assert ledger_queue._task is None
