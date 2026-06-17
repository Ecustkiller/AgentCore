"""Tests for the Turn Journal projection transforms (§18.3 唯一事实源).

``entries_from_runs`` flattens the in-memory ``runs`` replay payload into the
journal's ordered facts; ``runs_from_entries`` projects them back. The two must be
exact inverses so a turn round-trips through ``turn_journal`` unchanged — that is
what lets the message's ``runs`` be a pure projection rather than a stored blob.
"""

from agentcore.runtime.journal import entries_from_runs, runs_from_entries


def test_multi_agent_events_round_trip():
    runs = {
        "events": [
            {"type": "run_plan", "payload": {"execution_id": "e1"}, "timestamp": "t0"},
            {"type": "tool_use_start", "payload": {"tool_call_id": "c1"}, "timestamp": "t1"},
            {"type": "tool_use_end", "payload": {"tool_call_id": "c1"}, "timestamp": "t2"},
            {"type": "run_completed", "payload": {"run_id": "s1"}, "timestamp": "t3"},
        ],
        "finish_reason": "end_turn",
    }
    entries = entries_from_runs(runs)
    # Each event becomes a fact keeping its type as kind + its timestamp as ts; the
    # finish_reason rides a trailing turn_end fact.
    assert [e["kind"] for e in entries] == [
        "run_plan",
        "tool_use_start",
        "tool_use_end",
        "run_completed",
        "turn_end",
    ]
    assert entries[0]["ts"] == "t0"
    assert runs_from_entries(entries) == runs


def test_single_agent_process_round_trips_with_events_empty():
    runs = {
        "events": [],
        "finish_reason": "end_turn",
        "process": [
            {"kind": "reasoning", "text": "想一想"},
            {
                "kind": "tool",
                "id": "c1",
                "tool_name": "read_file",
                "arguments": {"path": "a"},
                "result": "ok",
                "status": "success",
            },
        ],
    }
    entries = entries_from_runs(runs)
    assert [e["kind"] for e in entries] == [
        "process_reasoning",
        "process_tool",
        "turn_end",
    ]
    # The process steps restore verbatim and events stays [] (single-agent turn).
    assert runs_from_entries(entries) == runs


def test_empty_and_none_payloads():
    assert entries_from_runs(None) == []
    assert entries_from_runs({}) == []
    # Nothing replayable projects back to None (matches the old「runs is NULL」shape).
    assert runs_from_entries(None) is None
    assert runs_from_entries([]) is None


def test_finish_reason_only_round_trips():
    # A turn with no events/process but a finish_reason still carries a turn_end fact,
    # so its outcome survives (e.g. a salvaged cancelled turn with empty journal).
    runs = {"events": [], "finish_reason": "cancelled"}
    entries = entries_from_runs(runs)
    assert [e["kind"] for e in entries] == ["turn_end"]
    assert runs_from_entries(entries) == runs


def test_process_absent_key_not_emitted_on_projection():
    # A multi-agent turn (no process) must not grow a ``process`` key when projected
    # back, so the shape matches ``_build_runs_payload`` exactly.
    runs = {
        "events": [{"type": "run_plan", "payload": {}, "timestamp": "t0"}],
        "finish_reason": "end_turn",
    }
    projected = runs_from_entries(entries_from_runs(runs))
    assert "process" not in projected
    assert projected == runs
