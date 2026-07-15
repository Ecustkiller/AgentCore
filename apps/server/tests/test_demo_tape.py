"""Unit tests for demo tape export / pacing / player (dev-only)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentcore.demo_tape.binding import conversation_is_cloud, write_binding
from agentcore.demo_tape.export import build_tape_events, build_tape_document, write_tape, load_tape
from agentcore.demo_tape.pacing import sleep_ms_for_gap
from agentcore.demo_tape.schema import DEMO_TAPE_FRAME_KEY, is_demo_tape_frame, should_export_kind
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType, FinishReason
from agentcore.runtime.suspension import TeamPreviewSuspension
from agentcore.runtime.runs.plan import RunPlan
from scripts.demo_tape_bind import build_parser


def test_should_export_skips_process_and_resolved():
    assert should_export_kind("run_started")
    assert should_export_kind("team_preview_required")
    assert not should_export_kind("team_preview_resolved")
    assert not should_export_kind("process_content")
    assert not should_export_kind("run_process_tool")
    assert not should_export_kind("turn_end")
    assert not should_export_kind("message_final")


def test_conversation_is_cloud_mirrors_desktop_routing():
    ok, reason = conversation_is_cloud(
        local_container_root_id=None,
        local_root_id=None,
        folder_local_root_id=None,
        folder_id=None,
    )
    assert ok and "bare cloud" in reason

    ok, reason = conversation_is_cloud(
        local_container_root_id="root-1",
        local_root_id=None,
        folder_local_root_id=None,
        folder_id=None,
    )
    assert not ok and "local container" in reason

    ok, reason = conversation_is_cloud(
        local_container_root_id=None,
        local_root_id=None,
        folder_local_root_id="folder-root",
        folder_id="f1",
    )
    assert not ok and "local-mode" in reason

    ok, reason = conversation_is_cloud(
        local_container_root_id="ignored",
        local_root_id=None,
        folder_local_root_id=None,
        folder_id="f-cloud",
    )
    assert ok and "cloud-mode" in reason


def test_write_binding_and_bind_parser(tmp_path: Path, monkeypatch):
    from agentcore.demo_tape import binding as binding_mod

    monkeypatch.setattr(binding_mod, "bindings_path", lambda: tmp_path / "bindings.json")
    path = write_binding("cid-1", tape="demos/tapes/x.json", speed=4.0, max_gap_ms=2000)
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["cid-1"] == {"tape": "demos/tapes/x.json", "speed": 4.0, "max_gap_ms": 2000}

    p = build_parser()
    args = p.parse_args(
        ["--latest", "--tape", "demos/tapes/x.json", "--speed", "4", "--max-gap-ms", "2000"]
    )
    assert args.latest is True
    assert args.conversation_id is None
    assert args.include_local is False

    args2 = p.parse_args(["abc-uuid", "--tape", "demos/tapes/x.json", "--include-local"])
    assert args2.conversation_id == "abc-uuid"
    assert args2.include_local is True


def test_pacing_speed_and_cap():
    assert sleep_ms_for_gap(gap_ms=0, speed=1.0, max_gap_ms=3000) == 0.0
    assert sleep_ms_for_gap(gap_ms=1000, speed=1.0, max_gap_ms=3000) == pytest.approx(1.0)
    assert sleep_ms_for_gap(gap_ms=1000, speed=4.0, max_gap_ms=3000) == pytest.approx(0.25)
    assert sleep_ms_for_gap(gap_ms=60_000, speed=1.0, max_gap_ms=2000) == pytest.approx(2.0)


def test_pacing_step_never_rewinds_clock():
    from agentcore.demo_tape.pacing import pacing_step

    gap, prev = pacing_step(prev_t_ms=None, t_ms=0)
    assert gap == 0 and prev == 0

    gap, prev = pacing_step(prev_t_ms=prev, t_ms=3000)
    assert gap == 3000 and prev == 3000

    # Synthetic overshoot then journal jump-back must not rewind.
    gap, prev = pacing_step(prev_t_ms=10_000, t_ms=12_000)
    assert gap == 2000 and prev == 12_000
    gap, prev = pacing_step(prev_t_ms=prev, t_ms=11_000)
    assert gap == 0 and prev == 12_000
    gap, prev = pacing_step(prev_t_ms=prev, t_ms=20_000)
    assert gap == 8000 and prev == 20_000


def test_export_origin_ignores_leading_null_ts():
    """Leading null ts must not become origin=0 leaving absolute epoch t_ms."""
    rows = [
        {"seq": 0, "kind": "run_started", "payload": {"run_id": "r1"}, "ts": None},
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "name": "web_search"},
            "ts": "2026-07-15T02:20:45.000Z",
        },
        {
            "seq": 2,
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "t1"},
            "ts": "2026-07-15T02:20:48.000Z",
        },
    ]
    events = build_tape_events(rows, chunk_size=28, chunk_gap_ms=35)
    assert events[0]["t_ms"] == 0
    assert events[1]["t_ms"] == 0  # same second as origin after leading fill
    # 3s later — relative, not epoch milliseconds
    assert events[2]["t_ms"] == 3000
    assert events[2]["t_ms"] < 60_000


def test_export_chunks_do_not_overshoot_next_anchor():
    rows = [
        {
            "seq": 0,
            "kind": "run_output_delta",
            "payload": {
                "run_id": "w1",
                "agent_id": "w1",
                "delta": "A" * 200,  # many chunks at 35ms would overshoot 100ms window
            },
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "run_completed",
            "payload": {"run_id": "w1"},
            "ts": "2026-07-15T02:20:42.100Z",  # +100ms
        },
    ]
    events = build_tape_events(rows, chunk_size=10, chunk_gap_ms=35)
    deltas = [e for e in events if e["kind"] == "run_output_delta"]
    completed = next(e for e in events if e["kind"] == "run_completed")
    assert deltas
    assert max(e["t_ms"] for e in deltas) <= completed["t_ms"]
    gaps = [events[i]["t_ms"] - events[i - 1]["t_ms"] for i in range(1, len(events))]
    assert all(g >= 0 for g in gaps)


def test_export_intro_stays_after_prior_event():
    rows = [
        {
            "seq": 0,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "name": "web_search"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp1",
                "form": "debate",
                "sides": [{"key": "a"}],
                "workers": [],
            },
            "ts": "2026-07-15T02:20:42.500Z",
        },
    ]
    intro = "案情介绍。" * 20  # long enough to want many chunks
    events = build_tape_events(
        rows, captain_content=intro + "\n\n---\n\nwrap", chunk_size=8, chunk_gap_ms=35
    )
    tool_i = next(i for i, e in enumerate(events) if e["kind"] == "tool_use_start")
    preview_i = next(i for i, e in enumerate(events) if e["kind"] == "team_preview_required")
    assert tool_i < preview_i
    for e in events[tool_i:preview_i]:
        assert e["t_ms"] >= events[tool_i]["t_ms"]
    gaps = [events[i]["t_ms"] - events[i - 1]["t_ms"] for i in range(1, len(events))]
    assert all(g >= 0 for g in gaps)


@pytest.mark.asyncio
async def test_player_pathological_gaps_do_not_double_sleep(monkeypatch):
    """Overshoot then jump-back must not re-sleep the overshot window."""
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import play_tape_events
    from agentcore.runtime.journal.writer import TurnJournalWriter

    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)

    monkeypatch.setattr(player_mod.asyncio, "sleep", fake_sleep)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    events = [
        {"kind": "run_started", "payload": {"run_id": "c1"}, "t_ms": 0},
        {"kind": "run_output_delta", "payload": {"run_id": "w1", "delta": "a"}, "t_ms": 1000},
        {"kind": "run_output_delta", "payload": {"run_id": "w1", "delta": "b"}, "t_ms": 5000},
        # jump back (chunk overshoot artifact)
        {"kind": "run_completed", "payload": {"run_id": "w1"}, "t_ms": 2000},
        {"kind": "run_started", "payload": {"run_id": "c2"}, "t_ms": 8000},
    ]
    binding = TapeBinding(
        conversation_id="conv",
        tape_path=Path("unused.json"),
        speed=1.0,
        max_gap_ms=600_000,
    )
    sink = EventSink(conversation_id="conv", message_id="msg")
    writer = TurnJournalWriter(turn_id="msg", conversation_id="conv", trace_id="t" * 32)
    await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="msg",
        conversation_id="conv",
        user_id="u",
        user_message="go",
        folder_id=None,
        journal_writer=writer,
    )
    # 0→1000 (1s) + 1000→5000 (4s) + 5000→2000 (0) + 5000→8000 (3s) = 8s total
    # Without never-rewind: last gap would be 8000-2000=6s → 11s total.
    assert sum(sleeps) == pytest.approx(8.0)
    assert max(sleeps) == pytest.approx(4.0)


def test_build_tape_chunks_deltas_and_drops_resolved():
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {"run_id": "r1", "kind": "captain"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp1",
                "form": "debate",
                "sides": [{"key": "a"}],
                "workers": [],
            },
            "ts": "2026-07-15T02:21:00.000Z",
        },
        {
            "seq": 2,
            "kind": "team_preview_resolved",
            "payload": {"checkpoint_id": "cp1", "decision": "continue"},
            "ts": "2026-07-15T02:21:10.000Z",
        },
        {
            "seq": 3,
            "kind": "run_output_delta",
            "payload": {
                "run_id": "w1",
                "agent_id": "w1",
                "delta": "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
            },
            "ts": "2026-07-15T02:22:00.000Z",
        },
        {
            "seq": 4,
            "kind": "debate_result",
            "payload": {"rounds": 1},
            "ts": "2026-07-15T02:23:00.000Z",
        },
        {
            "seq": 5,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "nope"},
            "ts": None,
        },
    ]
    events = build_tape_events(
        rows,
        captain_content="案情已经清晰。\n\n---\n\n最终汇总正文。",
        chunk_size=10,
        chunk_gap_ms=20,
    )
    kinds = [e["kind"] for e in events]
    assert "team_preview_resolved" not in kinds
    assert "process_content" not in kinds
    assert kinds.count("team_preview_required") == 1
    assert kinds.count("run_output_delta") >= 2  # chunked
    assert "content_delta" in kinds
    assert events[0]["t_ms"] == 0
    # Captain content re-join is byte-identical to source.
    captain = "".join(
        (e["payload"].get("delta") or "") for e in events if e["kind"] == "content_delta"
    )
    assert captain == "案情已经清晰。\n\n---\n\n最终汇总正文。"


def test_build_tape_preserves_started_before_context_on_equal_ts():
    """Equal timestamps must not reorder run_context ahead of run_started (kind sort)."""
    rows = [
        {
            "seq": 20,
            "kind": "run_started",
            "payload": {
                "run_id": "debate_x_r1_lv",
                "agent_id": "debate_x_r1_lv",
                "kind": "agent",
                "parent_run_id": "debate_x",
            },
            "ts": "2026-07-15T02:21:37.000Z",
        },
        {
            "seq": 21,
            "kind": "run_context",
            "payload": {
                "run_id": "debate_x_r1_lv",
                "agent_id": "debate_x_r1_lv",
                "blocks": [{"channel": "task", "body": "立论"}, {"channel": "cross_exam", "body": "q"}],
            },
            "ts": "2026-07-15T02:21:37.000Z",
        },
    ]
    events = build_tape_events(rows, chunk_size=28, chunk_gap_ms=35)
    kinds = [e["kind"] for e in events]
    assert kinds.index("run_started") < kinds.index("run_context")


def test_chunk_text_prefers_newline_and_joins_lossless():
    from agentcore.demo_tape.schema import chunk_text

    text = "| a | b |\n|---|---|\n| 1 | 2 |\n"
    parts = chunk_text(text, size=10)
    assert "".join(parts) == text
    # Prefer not to leave a dangling partial separator row in its own chunk mid-stream.
    assert any(p.endswith("\n") for p in parts[:-1])


def test_write_and_load_tape(tmp_path: Path):
    doc = build_tape_document(
        rows=[
            {
                "seq": 0,
                "kind": "run_started",
                "payload": {"run_id": "r1"},
                "ts": "2026-07-15T02:20:42.000Z",
            }
        ],
        meta={"title": "t"},
        user_prompt="hi",
    )
    path = tmp_path / "t.json"
    write_tape(path, doc)
    loaded = load_tape(path)
    assert loaded["version"] == 1
    assert loaded["meta"]["user_prompt"] == "hi"
    assert len(loaded["events"]) == 1


@pytest.mark.asyncio
async def test_player_pauses_and_continues(monkeypatch, tmp_path: Path):
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import continue_tape_turn, play_tape_events
    from agentcore.runtime.journal.writer import TurnJournalWriter

    saved: list = []

    async def fake_save(suspension):
        saved.append(suspension)

    monkeypatch.setattr(player_mod, "save_paused_turn", fake_save)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    events = [
        {"kind": "run_started", "payload": {"run_id": "c1", "kind": "captain"}, "t_ms": 0},
        {
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp-tape",
                "form": "debate",
                "sides": [{"key": "lv", "name": "LV"}],
                "workers": [],
                "tools": [],
                "primitive": "debate",
                "motion": "m",
                "max_rounds": 4,
                "thorough": True,
            },
            "t_ms": 100,
        },
        {"kind": "team_preview_resolved", "payload": {"decision": "continue"}, "t_ms": 200},
        {
            "kind": "run_output_delta",
            "payload": {"run_id": "w1", "agent_id": "w1", "delta": "hello"},
            "t_ms": 300,
        },
        {"kind": "content_delta", "payload": {"delta": "summary"}, "t_ms": 400},
    ]
    tape_path = tmp_path / "mini.json"
    tape_path.write_text(
        json.dumps({"version": 1, "meta": {}, "events": events}, ensure_ascii=False),
        encoding="utf-8",
    )
    binding = TapeBinding(
        conversation_id="conv1",
        tape_path=tape_path,
        speed=100.0,
        max_gap_ms=50,
    )
    sink = EventSink(conversation_id="conv1", message_id="msg1")
    writer = TurnJournalWriter(turn_id="msg1", conversation_id="conv1", trace_id="t" * 32)

    result = await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="msg1",
        conversation_id="conv1",
        user_id="user1",
        user_message="go",
        folder_id=None,
        journal_writer=writer,
    )
    assert result["finish_reason"] is FinishReason.PAUSED
    assert len(saved) == 1
    assert is_demo_tape_frame(saved[0])
    assert DEMO_TAPE_FRAME_KEY in saved[0].debate_arguments
    types = [e.type for e in sink._history]
    assert EventType.TEAM_PREVIEW_REQUIRED in types
    # message_end is transport-only (not in _history); PAUSED finish is the signal.

    # Continue after resolve
    sink2 = EventSink(conversation_id="conv1", message_id="msg1")
    suspension = saved[0]
    assert isinstance(suspension, TeamPreviewSuspension)
    result2 = await continue_tape_turn(
        suspension=suspension,
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE, note=""),
        sink=sink2,
        folder_id=None,
        trace_id="t" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    assert "summary" in (result2.get("content") or "")
    types2 = [e.type for e in sink2._history]
    assert EventType.TEAM_PREVIEW_RESOLVED in types2
    assert EventType.RUN_OUTPUT_DELTA in types2
    # Recorded resolve must not be double-emitted from tape
    assert types2.count(EventType.TEAM_PREVIEW_RESOLVED) == 1
    # Reload path: journal_entries must carry message_final so fold can splice deltas.
    entries = result2.get("journal_entries") or []
    assert any(e.get("kind") == "message_final" for e in entries)
