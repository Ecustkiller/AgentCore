"""Tests for the execution-level Turn Journal facts (§18.3, 执行级落地).

Covers the six execution-fact dataclasses (their journal-entry shape), the in-memory
:class:`TurnFactLog` recorder (ordering + entry projection), and the guard that keeps
these execution-only facts OUT of the display projection (``runs_from_entries``) — the
property that makes adding them a pure, non-disturbing change.
"""

from agentcore.runtime.facts import (
    EXECUTION_ONLY_KINDS,
    FactKind,
    FactRecorder,
    LlmCallFact,
    MessageFinalFact,
    NoteFact,
    RoundBoundaryFact,
    ToolCallFact,
    TurnFactLog,
    TurnStartedFact,
    current_fact_log,
    snapshot_fact_log,
)
from agentcore.runtime.journal import entries_from_runs, runs_from_entries


def test_turn_started_fact_entry_shape():
    fact = TurnStartedFact(
        system_prompt="你是 CEO",
        user_message="写个脚本",
        model_profile="chat",
        history_len=4,
    ).to_fact()
    entry = fact.entry()
    assert entry["kind"] == "turn_started"
    assert entry["ts"] is None
    assert entry["payload"] == {
        "system_prompt": "你是 CEO",
        "user_message": "写个脚本",
        "model_profile": "chat",
        "history_len": 4,
    }


def test_round_boundary_fact_entry_shape():
    entry = RoundBoundaryFact(round_idx=2, run_id="captain", role="captain").to_fact().entry()
    assert entry["kind"] == "round_boundary"
    assert entry["payload"] == {"round_idx": 2, "run_id": "captain", "role": "captain"}


def test_llm_call_fact_preserves_reasoning_and_tool_calls():
    # The fold must reproduce reasoning_content + tool_calls byte-for-byte (DeepSeek
    # thinking echo), so the fact must carry both verbatim.
    tool_calls = [{"id": "c1", "function": {"name": "delegate", "arguments": "{}"}}]
    usage = {"input_tokens": 10, "output_tokens": 20}
    entry = (
        LlmCallFact(
            run_id="captain",
            round_idx=0,
            content="先规划",
            reasoning_content="让我想想",
            tool_calls=tool_calls,
            usage=usage,
            finish_reason="tool_calls",
        )
        .to_fact()
        .entry()
    )
    assert entry["kind"] == "llm_call"
    assert entry["payload"]["content"] == "先规划"
    assert entry["payload"]["reasoning_content"] == "让我想想"
    assert entry["payload"]["tool_calls"] == tool_calls
    assert entry["payload"]["usage"] == usage
    assert entry["payload"]["finish_reason"] == "tool_calls"


def test_llm_call_fact_defaults_empty_collections():
    # A tool-free final round carries no tool_calls / usage — they normalize to empty
    # containers (never None) so the stored payload shape is stable.
    payload = (
        LlmCallFact(run_id="captain", round_idx=1, content="答案").to_fact().entry()["payload"]
    )
    assert payload["tool_calls"] == []
    assert payload["usage"] == {}
    assert payload["reasoning_content"] == ""
    assert payload["finish_reason"] is None


def test_tool_call_fact_entry_shape():
    # The execution tool_call fact carries the FULL model-facing result (post-annotation)
    # the window folds, scoped by run_id and paired by tool_call_id (执行级落地 边界①).
    entry = (
        ToolCallFact(
            run_id="captain",
            tool_call_id="c1",
            name="search",
            arguments='{"q": "x"}',
            result="结果全文\n\n[来源编号] [1]=https://e.com",
            success=True,
        )
        .to_fact()
        .entry()
    )
    assert entry["kind"] == "tool_call"
    assert entry["payload"] == {
        "run_id": "captain",
        "tool_call_id": "c1",
        "name": "search",
        "arguments": '{"q": "x"}',
        "result": "结果全文\n\n[来源编号] [1]=https://e.com",
        "success": True,
    }


def test_note_and_message_final_fact_shapes():
    note = (
        NoteFact(role="user", content="停止使用工具", reason="finalize", run_id="captain")
        .to_fact()
        .entry()
    )
    assert note["kind"] == "note"
    # run_id rides the note so a captain note injected mid-delegate folds into the captain
    # window (边界②); it defaults to "" for a note recorded outside a scoped run.
    assert note["payload"] == {
        "role": "user",
        "content": "停止使用工具",
        "reason": "finalize",
        "run_id": "captain",
    }

    final = (
        MessageFinalFact(run_id="w1", content="全文产出", reasoning="思考全文").to_fact().entry()
    )
    assert final["kind"] == "message_final"
    assert final["payload"] == {"run_id": "w1", "content": "全文产出", "reasoning": "思考全文"}


def test_to_fact_accepts_optional_timestamp():
    fact = NoteFact(role="user", content="x").to_fact(ts="2026-06-18T00:00:00.000Z")
    assert fact.ts == "2026-06-18T00:00:00.000Z"
    assert fact.entry()["ts"] == "2026-06-18T00:00:00.000Z"


def test_execution_only_kinds_match_enum():
    assert {
        "turn_started",
        "round_boundary",
        "llm_call",
        "tool_call",
        "note",
        "message_final",
        # 执行级事件溯源 Phase 2 (frame.plan 退场): the delegate's DAG snapshot — a value
        # distinct from the display ``run_plan`` event so the display gate is untouched.
        "plan_snapshot",
        "coordination_snapshot",
    } == EXECUTION_ONLY_KINDS
    assert frozenset(k.value for k in FactKind) == EXECUTION_ONLY_KINDS


def test_turn_fact_log_records_in_order():
    log = TurnFactLog()
    assert not log  # empty is falsy
    log.record_fact(TurnStartedFact("sys", "hi", "chat").to_fact())
    log.record_fact(RoundBoundaryFact(0, "captain", "captain").to_fact())
    log.record_fact(LlmCallFact("captain", 0, content="ok").to_fact())
    assert len(log) == 3
    assert bool(log) is True
    assert [e["kind"] for e in log.entries()] == ["turn_started", "round_boundary", "llm_call"]


def test_turn_fact_log_inherited_entries_prefix():
    inherited = [
        {"kind": "turn_started", "payload": {"user_message": "hi"}, "ts": "t0"},
        {"kind": "round_boundary", "payload": {"round_idx": 0}, "ts": None},
    ]
    log = TurnFactLog(inherited_entries=inherited)
    assert not log  # segment empty — inherited does not count toward len/bool
    log.record_fact(LlmCallFact("captain", 0, content="more").to_fact())
    assert len(log) == 1
    assert [e["kind"] for e in log.entries()] == [
        "turn_started",
        "round_boundary",
        "llm_call",
    ]
    assert [e["kind"] for e in log.segment_entries()] == ["llm_call"]


def test_snapshot_fact_log_includes_inherited_prefix():
    from agentcore.runtime.facts import current_fact_log, snapshot_fact_log

    inherited = [TurnStartedFact("sys", "hi", "chat").to_fact().entry()]
    log = TurnFactLog(inherited_entries=inherited)
    token = current_fact_log.set(log)
    try:
        log.record_fact(RoundBoundaryFact(0, "captain", "captain").to_fact())
        entries = snapshot_fact_log(trailing=[{"kind": "checkpoint_required", "payload": {}}])
        assert [e["kind"] for e in entries] == [
            "turn_started",
            "round_boundary",
            "checkpoint_required",
        ]
    finally:
        current_fact_log.reset(token)


def test_turn_fact_log_seed_from_entries():
    log = TurnFactLog()
    log.seed_from_entries(
        [
            {"kind": "turn_started", "payload": {"user_message": "hi"}, "ts": "t0"},
            {"kind": "round_boundary", "payload": {"round_idx": 0}, "ts": None},
            {"type": "checkpoint_required", "payload": {"id": "cp"}},  # display — skipped
        ]
    )
    log.record_fact(LlmCallFact("captain", 0, content="more").to_fact())
    assert [e["kind"] for e in log.entries()] == [
        "turn_started",
        "round_boundary",
        "llm_call",
    ]


def test_snapshot_fact_log_after_resume_seed_includes_turn_started():
    """Resume seeds the ambient log so a downstream checkpoint sees the full stream."""
    prior = [
        TurnStartedFact("sys", "hi", "chat").to_fact().entry(),
        RoundBoundaryFact(0, "r1", "captain").to_fact().entry(),
    ]
    log = TurnFactLog()
    log.seed_from_entries(prior)
    token = current_fact_log.set(log)
    try:
        log.record_fact(LlmCallFact("r1", 1, content="续跑").to_fact())
        snap = snapshot_fact_log()
    finally:
        current_fact_log.reset(token)
    assert snap[0]["kind"] == "turn_started"
    assert [e["kind"] for e in snap] == ["turn_started", "round_boundary", "llm_call"]


def test_turn_fact_log_is_a_fact_recorder():
    # The in-memory log satisfies the engine-facing write port (runtime_checkable).
    assert isinstance(TurnFactLog(), FactRecorder)


def test_display_projection_skips_execution_facts():
    # Execution facts interleaved with display events must NOT leak into runs.events
    # (the client fold would choke on an unknown event type) — they are skipped, while
    # the genuine display events + turn_end still project as before.
    entries = [
        TurnStartedFact("sys", "hi", "chat").to_fact().entry(),
        {"kind": "run_plan", "payload": {"execution_id": "e1"}, "ts": "t0"},
        RoundBoundaryFact(0, "captain", "captain").to_fact().entry(),
        LlmCallFact("captain", 0, content="ok").to_fact().entry(),
        {"kind": "run_completed", "payload": {"run_id": "s1"}, "ts": "t1"},
        MessageFinalFact("captain", content="全文").to_fact().entry(),
        {"kind": "turn_end", "payload": {"finish_reason": "end_turn"}, "ts": None},
    ]
    runs = runs_from_entries(entries)
    assert runs is not None
    assert [e["type"] for e in runs["events"]] == ["run_plan", "run_completed"]
    assert runs["finish_reason"] == "end_turn"


def test_display_round_trip_unaffected_by_guard():
    # The existing display round-trip (no execution facts) is unchanged by the new skip.
    runs = {
        "events": [
            {"type": "run_plan", "payload": {"execution_id": "e1"}, "timestamp": "t0"},
            {"type": "run_completed", "payload": {"run_id": "s1"}, "timestamp": "t1"},
        ],
        "finish_reason": "end_turn",
    }
    assert runs_from_entries(entries_from_runs(runs)) == runs
