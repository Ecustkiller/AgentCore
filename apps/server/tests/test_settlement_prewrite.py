"""Settlement prewrite + journal writer dedupe / priority (提问确认交互统一 P1 · D8)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agentcore.runtime.events import approval_resolved, checkpoint_resolved
from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.settlement import (
    entry_from_sse,
    prewrite_cold_resume_settlement,
    prewrite_settlement,
    prewrite_settlement_direct,
    seed_settlement_dedupe_from_entries,
)
from agentcore.runtime.suspension import AskUserSuspension


class _FakeStore:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []
        self.fail_kinds: set[str] = set()
        self.lock = asyncio.Lock()

    async def append_journal(
        self,
        *,
        turn_id: str,
        seq: int | None,
        conversation_id: str,
        trace_id: str | None,
        entry: dict[str, Any],
    ) -> int | None:
        async with self.lock:
            kind = str(entry.get("kind") or "")
            if kind in self.fail_kinds:
                raise RuntimeError(f"forced fail: {kind}")
            # Mirror CloudStore: live passes seq=None (DB allocates); record the
            # caller's seq arg for assertions, return a synthetic durable seq.
            allocated = len(self.rows) if seq is None else int(seq)
            self.rows.append(
                {
                    "turn_id": turn_id,
                    "seq": seq,
                    "conversation_id": conversation_id,
                    "entry": entry,
                }
            )
            return allocated


def _ask_frame() -> AskUserSuspension:
    return AskUserSuspension(
        message_id="m1",
        conversation_id="c1",
        user_id="u1",
        captain_run_id="cap1",
        checkpoint_id="ck1",
        tool_call_id="call_ask",
        base_system_prompt="sys",
        user_message="A 还是 B?",
        transcript=[],
        question="A 还是 B?",
        questions=[
            {
                "id": "q0",
                "prompt": "A 还是 B?",
                "kind": "choice",
                "options": ["A", "B"],
                "multiple": False,
                "default": "",
            }
        ],
    )


@pytest.mark.asyncio
async def test_settlement_prewrite_priority_and_dedupe(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeStore()
    monkeypatch.setattr(
        "agentcore.conversation.store.get_conversation_store",
        lambda: store,
    )

    writer = TurnJournalWriter(turn_id="t1", conversation_id="c1", trace_id=None)
    token = current_journal_writer.set(writer)
    try:
        # Queue a normal fact first
        fut_normal = writer.schedule_append(
            {"kind": "run_started", "payload": {"run_id": "r"}, "ts": "t"}
        )
        event = approval_resolved(
            approval_id="a1", tool_call_id="a1", decision="approve"
        )
        await prewrite_settlement(event)
        # Awaiter re-emit should dedupe (no second journal row)
        fut_dup = writer.schedule_append(
            {
                "kind": "approval_resolved",
                "payload": {
                    "approval_id": "a1",
                    "tool_call_id": "a1",
                    "decision": "approve",
                },
                "ts": "t",
            }
        )
        await writer.flush()
        if fut_normal:
            await fut_normal
        if fut_dup:
            await fut_dup
    finally:
        current_journal_writer.reset(token)

    kinds = [r["entry"]["kind"] for r in store.rows]
    assert kinds.count("approval_resolved") == 1
    assert "run_started" in kinds


@pytest.mark.asyncio
async def test_settlement_prewrite_failure_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeStore()
    store.fail_kinds.add("approval_resolved")
    monkeypatch.setattr(
        "agentcore.conversation.store.get_conversation_store",
        lambda: store,
    )

    writer = TurnJournalWriter(turn_id="t1", conversation_id="c1", trace_id=None)
    token = current_journal_writer.set(writer)
    try:
        event = approval_resolved(
            approval_id="a1", tool_call_id="a1", decision="approve"
        )
        with pytest.raises(RuntimeError, match="forced fail"):
            await prewrite_settlement(event)
    finally:
        current_journal_writer.reset(token)


@pytest.mark.asyncio
async def test_concurrent_writers_use_db_seq_none(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two writers enqueue concurrently; both pass seq=None (DB allocates)."""
    store = _FakeStore()
    monkeypatch.setattr(
        "agentcore.conversation.store.get_conversation_store",
        lambda: store,
    )

    w1 = TurnJournalWriter(turn_id="t1", conversation_id="c1", trace_id=None)
    w2 = TurnJournalWriter(turn_id="t1", conversation_id="c1", trace_id=None)

    async def burst(w: TurnJournalWriter, n: int) -> None:
        futs = []
        for i in range(n):
            futs.append(
                w.schedule_append(
                    {"kind": "run_progress", "payload": {"i": i}, "ts": "t"}
                )
            )
        await w.flush()
        for f in futs:
            if f:
                await f

    await asyncio.gather(burst(w1, 5), burst(w2, 5))
    assert len(store.rows) == 10
    assert all(r["seq"] is None for r in store.rows)


@pytest.mark.asyncio
async def test_cold_resume_settlement_fail_skips_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D8 冷路：settlement 落库失败 ⇒ 不 claim、paused frame 保留可重试."""
    store = _FakeStore()
    store.fail_kinds.add("checkpoint_resolved")
    monkeypatch.setattr(
        "agentcore.conversation.store.get_conversation_store",
        lambda: store,
    )

    async def _no_existing(_turn_id: str, _key: tuple[str, str, str]) -> bool:
        return False

    monkeypatch.setattr(
        "agentcore.runtime.settlement._journal_has_settlement",
        _no_existing,
    )

    frame = _ask_frame()
    frames: dict[str, AskUserSuspension] = {frame.message_id: frame}
    claimed: list[str] = []

    async def fake_claim(message_id: str, *, conversation_id: str | None = None):
        claimed.append(message_id)
        return frames.pop(message_id, None)

    # Mirror resume_message: prewrite must succeed before claim.
    prewrite_error: Exception | None = None
    try:
        await prewrite_cold_resume_settlement(
            frame, decision="continue", note="", selected=["A"]
        )
    except Exception as e:  # noqa: BLE001 — route maps this to 5xx
        prewrite_error = e
    else:
        await fake_claim(frame.message_id, conversation_id=frame.conversation_id)

    assert prewrite_error is not None
    assert "forced fail" in str(prewrite_error)
    assert claimed == []
    assert frame.message_id in frames
    assert store.rows == []


@pytest.mark.asyncio
async def test_cold_resume_pipeline_emit_dedupes_prewrite(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """D8 冷路：预写后 resume writer 种子化 dedupe ⇒ pipeline 重放 emit 不重复落库."""
    store = _FakeStore()
    monkeypatch.setattr(
        "agentcore.conversation.store.get_conversation_store",
        lambda: store,
    )

    async def _no_existing(_turn_id: str, _key: tuple[str, str, str]) -> bool:
        return False

    monkeypatch.setattr(
        "agentcore.runtime.settlement._journal_has_settlement",
        _no_existing,
    )

    event = checkpoint_resolved(
        checkpoint_id="ck1", decision="continue", note="", selected=["A"]
    )
    await prewrite_settlement_direct(
        turn_id="m1",
        conversation_id="c1",
        trace_id=None,
        event=event,
    )
    assert [r["entry"]["kind"] for r in store.rows] == ["checkpoint_resolved"]

    # Resume pipeline: new writer seeded from claim-rehydrated journal_entries.
    writer = TurnJournalWriter(turn_id="m1", conversation_id="c1", trace_id=None)
    seed_settlement_dedupe_from_entries(writer, [entry_from_sse(event)])
    token = current_journal_writer.set(writer)
    try:
        fut = writer.schedule_append(entry_from_sse(event))
        await writer.flush()
        if fut:
            await fut
    finally:
        current_journal_writer.reset(token)

    kinds = [r["entry"]["kind"] for r in store.rows]
    assert kinds.count("checkpoint_resolved") == 1
