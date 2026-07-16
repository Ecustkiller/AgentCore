"""Process-lane progressive persistence + attach replay (mid-run refresh)."""

from __future__ import annotations

from agentcore.conversation.store.merge import MESSAGE_STATUS_RUNNING
from agentcore.conversation.store.overlay import overlay_message_fields
from agentcore.runtime.events import (
    EventSink,
    FinishReason,
    content_delta,
    reasoning_delta,
    run_output_delta,
    run_reasoning_delta,
    tool_use_end,
    tool_use_start,
)
from agentcore.runtime.events.attach_replay import journal_rows_to_sse, synthesize_segment_deltas
from agentcore.runtime.events.stream_checkpointer import CHANNEL_CAPTAIN_CONTENT
from agentcore.runtime.events.types import EventType
from agentcore.runtime.facts import TurnFactLog, current_fact_log
from agentcore.runtime.pipeline.finalize import _journal_entries_for_turn


def test_sink_persists_closed_content_before_tool():
    """tool_use_start closes the open content step → process_content in fact_log."""
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        sink.emit(content_delta("## 旁白\n先介绍。"))
        sink.emit(tool_use_start("tc1", "web_search", {"query": "x"}))
        kinds = [e["kind"] for e in log.entries()]
        assert "process_content" in kinds
        content_facts = [e for e in log.entries() if e["kind"] == "process_content"]
        assert content_facts[0]["payload"]["text"] == "## 旁白\n先介绍。"
        # Tool still running — not journaled until tool_use_end.
        assert "process_tool" not in kinds
        sink.emit(
            tool_use_end("tc1", "web_search", success=True, output="ok")
        )
        kinds2 = [e["kind"] for e in log.entries()]
        assert "process_tool" in kinds2
        tool = next(e for e in log.entries() if e["kind"] == "process_tool")
        assert tool["payload"]["status"] == "success"
        assert tool["payload"]["result"] == "ok"
    finally:
        current_fact_log.reset(token)


def test_sink_persists_run_process_symmetrically():
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        sink.emit(run_reasoning_delta("r1", "w1", "先想。"))
        sink.emit(tool_use_start("tc1", "web_search", {"query": "q"}, run_id="r1"))
        kinds = [e["kind"] for e in log.entries()]
        assert "run_process_reasoning" in kinds
        assert "run_process_tool" not in kinds
        sink.emit(
            tool_use_end("tc1", "web_search", success=True, output="hit", run_id="r1")
        )
        sink.emit(run_output_delta("r1", "w1", "结论。"))
        sink.flush_process_to_journal()
        kinds2 = [e["kind"] for e in log.entries()]
        assert "run_process_tool" in kinds2
        assert "run_process_content" in kinds2
    finally:
        current_fact_log.reset(token)


def test_finalize_only_appends_turn_end_when_process_already_in_log():
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        sink.emit(content_delta("旁白"))
        sink.emit(tool_use_start("tc1", "web_search", {"query": "x"}))
        sink.emit(tool_use_end("tc1", "web_search", success=True, output="ok"))
        sink.emit(content_delta("交付"))
        # Surface the journal so _should_persist_journal passes.
        sink.seed_journal(
            [{"type": "tool_use_start", "payload": {"tool_call_id": "tc1"}, "timestamp": "t0"}]
        )
        before = len(log.entries())
        durable = _journal_entries_for_turn(log, sink=sink, finish=FinishReason.END_TURN)
        assert durable is not None
        assert durable[-1]["kind"] == "turn_end"
        # No second full process dump — process_* count did not double.
        process_kinds = [e["kind"] for e in durable if e["kind"].startswith("process_")]
        assert process_kinds.count("process_content") == 2  # 旁白 + 交付 (flushed tail)
        assert process_kinds.count("process_tool") == 1
        # Flush may add the open trailing content; only turn_end is the finalize-only append.
        assert durable[-1] == {
            "kind": "turn_end",
            "payload": {"finish_reason": "end_turn"},
            "ts": None,
        }
        assert len(durable) >= before + 1
    finally:
        current_fact_log.reset(token)


def test_journal_rows_to_sse_interleaves_process_with_tools():
    """Attach replay: process_content before tool_use_start, not after all DURABLE."""
    rows = [
        {
            "seq": 1,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "旁白"},
            "ts": "t0",
        },
        {
            "seq": 2,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "arguments": {}},
            "ts": "t1",
        },
        {
            "seq": 3,
            "kind": "tool_use_end",
            "payload": {
                "tool_call_id": "t1",
                "tool_name": "web_search",
                "status": "success",
                "result": "ok",
            },
            "ts": "t2",
        },
        {
            "seq": 4,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "交付"},
            "ts": "t3",
        },
        {
            "seq": 5,
            "kind": "process_tool",
            "payload": {
                "kind": "tool",
                "id": "t1",
                "tool_name": "web_search",
                "status": "success",
                "result": "ok",
            },
            "ts": "t4",
        },
    ]
    events = journal_rows_to_sse(rows)
    types = [e.type for e in events]
    assert types == [
        EventType.CONTENT_DELTA,
        EventType.TOOL_USE_START,
        EventType.TOOL_USE_END,
        EventType.CONTENT_DELTA,
    ]
    assert events[0].payload["delta"] == "旁白"
    assert events[0].seq == 1
    assert events[3].payload["delta"] == "交付"


def test_journal_rows_to_sse_run_process_interleave():
    rows = [
        {
            "seq": 1,
            "kind": "run_started",
            "payload": {"run_id": "r1", "agent_id": "w1", "kind": "agent"},
            "ts": "t0",
        },
        {
            "seq": 2,
            "kind": "run_process_reasoning",
            "payload": {"run_id": "r1", "kind": "reasoning", "text": "想"},
            "ts": "t1",
        },
        {
            "seq": 3,
            "kind": "tool_use_start",
            "payload": {
                "tool_call_id": "t1",
                "tool_name": "web_search",
                "arguments": {},
                "run_id": "r1",
            },
            "ts": "t2",
        },
        {
            "seq": 4,
            "kind": "run_process_content",
            "payload": {"run_id": "r1", "kind": "content", "text": "结论"},
            "ts": "t3",
        },
    ]
    events = journal_rows_to_sse(rows)
    types = [e.type for e in events]
    assert types == [
        EventType.RUN_STARTED,
        EventType.RUN_REASONING_DELTA,
        EventType.TOOL_USE_START,
        EventType.RUN_OUTPUT_DELTA,
    ]
    assert events[1].payload["delta"] == "想"
    assert events[1].payload["agent_id"] == "w1"


def test_synthesize_skips_captain_when_journal_has_process():
    events = synthesize_segment_deltas(
        by_channel={CHANNEL_CAPTAIN_CONTENT: "FROM_SEGMENT"},
        agent_run_ids={},
        covered_run_ids=set(),
        skip_captain_content=True,
    )
    assert events == []


def test_overlay_skips_captain_content_when_process_present():
    content, reasoning = overlay_message_fields(
        content="",
        reasoning_content=None,
        segments=[{"channel": CHANNEL_CAPTAIN_CONTENT, "text": "旁白不该进 content"}],
        usage={"status": MESSAGE_STATUS_RUNNING},
        skip_captain_content=True,
    )
    assert content == ""
    # Without skip, narration would pour in:
    content2, _ = overlay_message_fields(
        content="",
        reasoning_content=None,
        segments=[{"channel": CHANNEL_CAPTAIN_CONTENT, "text": "旁白不该进 content"}],
        usage={"status": MESSAGE_STATUS_RUNNING},
        skip_captain_content=False,
    )
    assert content2 == "旁白不该进 content"


def test_seed_process_skips_rewriting_on_flush():
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        sink.seed_process([{"kind": "content", "text": "pre"}])
        sink.emit(reasoning_delta("post"))
        sink.flush_process_to_journal()
        kinds = [e["kind"] for e in log.entries()]
        # Seeded content not re-appended; only live reasoning.
        assert kinds == ["process_reasoning"]
        assert log.entries()[0]["payload"]["text"] == "post"
    finally:
        current_fact_log.reset(token)


def test_content_reset_does_not_journal_discarded_open_content():
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        from agentcore.runtime.events import content_reset

        sink.emit(content_delta("将被丢弃"))
        # Still open — not persisted yet.
        assert log.entries() == []
        sink.emit(content_reset("finish_guard"))
        sink.flush_process_to_journal()
        assert log.entries() == []
    finally:
        current_fact_log.reset(token)


def test_process_content_journals_before_tool_use_start():
    """Emit order: closed process_* must precede the DURABLE that closed it."""
    log = TurnFactLog()
    token = current_fact_log.set(log)
    sink = EventSink()
    try:
        sink.emit(content_delta("## 旁白"))
        sink.emit(tool_use_start("tc1", "web_search", {"query": "x"}))
        kinds = [e["kind"] for e in log.entries()]
        assert kinds.index("process_content") < kinds.index("tool_use_start")
    finally:
        current_fact_log.reset(token)


def test_structured_journal_skips_segment_narration_fallback():
    """Ratchet: structured turns must not stitch 旁白 from captain:content segments."""
    from agentcore.runtime.events.attach_replay import (
        journal_is_structured,
        synthesize_segment_deltas,
    )

    rows = [
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "arguments": {}},
            "ts": "t0",
        }
    ]
    assert journal_is_structured(rows)
    # No process_* yet (legacy / pre-boundary) — still must not pour segments.
    events = synthesize_segment_deltas(
        by_channel={CHANNEL_CAPTAIN_CONTENT: "旁白不应从 segment 拼回"},
        agent_run_ids={},
        covered_run_ids=set(),
        skip_captain_content=True,
    )
    assert events == []


def test_prose_only_journal_keeps_segment_accelerate():
    from agentcore.runtime.events.attach_replay import journal_is_structured

    rows = [
        {"seq": 1, "kind": "turn_started", "payload": {"user_message": "hi"}, "ts": None},
    ]
    assert not journal_is_structured(rows)
