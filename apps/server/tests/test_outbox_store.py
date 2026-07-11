"""OutboxStore progressive write + idempotency tests (as-built: 双模式工作区 §10.3)."""

from __future__ import annotations

import asyncio
import json

import pytest

from agentcore.conversation.store import reset_conversation_store_for_tests
from agentcore.conversation.store.outbox import (
    PHASE_READY,
    OutboxStore,
    list_outbox_records,
    to_record_turn_body,
)


@pytest.fixture(autouse=True)
def _reset_conversation_store():
    yield
    reset_conversation_store_for_tests()


def _drive(coro):
    return asyncio.run(coro)


def test_progressive_begin_checkpoint_finalize(tmp_path):
    store = OutboxStore(tmp_path / "outbox")
    store.bind_turn(
        conversation_id="c1",
        user_message_id="u1",
        user_message="hello",
        message_id="m1",
        trace_id="a" * 32,
    )

    async def run() -> dict:
        await store.begin_turn(conversation_id="c1", message_id="m1", trace_id="a" * 32)
        await store.checkpoint(conversation_id="c1", message_id="m1", content="Hel")
        await store.checkpoint(conversation_id="c1", message_id="m1", content="Hello")
        # Shorter checkpoint must not shrink (monotonic).
        await store.checkpoint(conversation_id="c1", message_id="m1", content="He")
        await store.append_journal(
            turn_id="m1",
            seq=0,
            conversation_id="c1",
            trace_id="a" * 32,
            entry={"kind": "run_started", "payload": {}},
        )
        await store.append_journal(
            turn_id="m1",
            seq=0,  # duplicate seq — ignored
            conversation_id="c1",
            trace_id="a" * 32,
            entry={"kind": "SHOULD_NOT_REPLACE", "payload": {}},
        )
        await store.finalize(
            mode="local",
            conversation_id="c1",
            user_message="hello",
            user_message_id="u1",
            assistant_content="Hello world",
            message_id="m1",
            trace_id="a" * 32,
            finish_reason="stop",
            input_tokens=3,
            output_tokens=2,
            runs={"events": []},
        )
        # Second finalize is a no-op seal.
        await store.finalize(
            mode="local",
            conversation_id="c1",
            user_message="hello",
            user_message_id="u1",
            assistant_content="SHORTER",
            message_id="m1",
            trace_id="a" * 32,
            finish_reason="stop",
        )
        return json.loads((tmp_path / "outbox" / "u1.json").read_text(encoding="utf-8"))

    record = _drive(run())
    assert record["phase"] == PHASE_READY
    assert record["content"] == "Hello world"
    assert record["journal"] == {"0": {"kind": "run_started", "payload": {}}}
    assert record["ops"][0] == "begin_turn"
    assert "finalize" in record["ops"]
    body = to_record_turn_body(record)
    assert body["user_message_id"] == "u1"
    assert body["content"] == "Hello world"
    assert body["input_tokens"] == 3


def test_begin_turn_idempotent(tmp_path):
    store = OutboxStore(tmp_path / "outbox")
    store.bind_turn(
        conversation_id="c1",
        user_message_id="u1",
        user_message="hi",
        message_id="m1",
        trace_id="b" * 32,
    )

    async def run() -> dict:
        await store.begin_turn(conversation_id="c1", message_id="m1", trace_id="b" * 32)
        await store.begin_turn(conversation_id="c1", message_id="m1", trace_id="b" * 32)
        return json.loads((tmp_path / "outbox" / "u1.json").read_text(encoding="utf-8"))

    record = _drive(run())
    assert record["ops"].count("begin_turn") == 1


def test_salvage_marks_ready(tmp_path):
    store = OutboxStore(tmp_path / "outbox")
    store.bind_turn(
        conversation_id="c1",
        user_message_id="u1",
        user_message="hi",
        message_id="m1",
        trace_id="c" * 32,
    )

    async def run() -> dict:
        await store.begin_turn(conversation_id="c1", message_id="m1", trace_id="c" * 32)
        await store.checkpoint(conversation_id="c1", message_id="m1", content="partial")
        await store.salvage(
            journal=[{"kind": "x"}],
            content="partial+",
            conversation_id="c1",
            trace_id="c" * 32,
            message_id="m1",
        )
        return json.loads((tmp_path / "outbox" / "u1.json").read_text(encoding="utf-8"))

    record = _drive(run())
    assert record["phase"] == PHASE_READY
    assert record["content"] == "partial+"
    assert record["finish_reason"] == "cancelled"
    assert "salvage" in record["ops"]
    body = to_record_turn_body(record)
    assert body["finish_reason"] == "cancelled"
    assert body["journal"] == [{"kind": "x"}]


def test_to_record_turn_body_includes_sorted_journal(tmp_path):
    """Crash salvage: runs=None but journal map must ride the write-back body."""
    store = OutboxStore(tmp_path / "outbox")
    store.bind_turn(
        conversation_id="c1",
        user_message_id="u1",
        user_message="hi",
        message_id="m1",
        trace_id="e" * 32,
    )

    async def run() -> dict:
        await store.begin_turn(conversation_id="c1", message_id="m1", trace_id="e" * 32)
        await store.append_journal(
            turn_id="m1",
            seq=2,
            conversation_id="c1",
            trace_id="e" * 32,
            entry={"kind": "run_completed", "payload": {"id": "r1"}, "ts": None},
        )
        await store.append_journal(
            turn_id="m1",
            seq=0,
            conversation_id="c1",
            trace_id="e" * 32,
            entry={"kind": "run_started", "payload": {"id": "r1"}, "ts": "t0"},
        )
        await store.checkpoint(conversation_id="c1", message_id="m1", content="partial")
        await store.salvage(
            journal=[],
            content="partial",
            conversation_id="c1",
            trace_id="e" * 32,
            message_id="m1",
        )
        return json.loads((tmp_path / "outbox" / "u1.json").read_text(encoding="utf-8"))

    record = _drive(run())
    assert record["runs"] is None
    body = to_record_turn_body(record)
    assert "runs" in body
    assert body["runs"] is None
    assert body["journal"] == [
        {"kind": "run_started", "payload": {"id": "r1"}, "ts": "t0"},
        {"kind": "run_completed", "payload": {"id": "r1"}, "ts": None},
    ]
    assert body["finish_reason"] == "cancelled"


def test_list_outbox_records(tmp_path):
    base = tmp_path / "outbox"
    store = OutboxStore(base)
    store.bind_turn(
        conversation_id="c1",
        user_message_id="u1",
        user_message="a",
        message_id="m1",
        trace_id="d" * 32,
    )
    _drive(store.begin_turn(conversation_id="c1", message_id="m1", trace_id="d" * 32))
    (base / "torn.json").write_text("{", encoding="utf-8")
    records = list_outbox_records(base)
    assert len(records) == 1
    assert records[0]["user_message_id"] == "u1"
