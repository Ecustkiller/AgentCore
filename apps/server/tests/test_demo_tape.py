"""Unit tests for demo tape export / pacing / player (dev-only)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentcore.demo_tape.binding import conversation_is_cloud, write_binding
from agentcore.demo_tape.export import build_tape_document, build_tape_events, load_tape, write_tape
from agentcore.demo_tape.pacing import sleep_ms_for_gap
from agentcore.demo_tape.schema import DEMO_TAPE_FRAME_KEY, is_demo_tape_frame, should_export_kind
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType, FinishReason
from agentcore.runtime.suspension import TeamPreviewSuspension
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


def test_export_places_reasoning_along_process_timeline():
    """Captain reasoning bursts anchor to the process timeline: pre-pause thinking lands
    before its tool / the case brief; wrap-up thinking lands in the closing window
    (orch tool_use_end → run_completed), reasoning before content. Content splits on the
    true段 boundary so the case brief stays whole before the card."""
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {"run_id": "cap", "kind": "captain"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "run_id": "cap"},
            "ts": "2026-07-15T02:20:43.000Z",
        },
        {
            "seq": 2,
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "run_id": "cap"},
            "ts": "2026-07-15T02:20:44.000Z",
        },
        {
            "seq": 3,
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp",
                "form": "debate",
                "sides": [{"key": "a"}],
                "workers": [],
            },
            "ts": "2026-07-15T02:20:45.000Z",
        },
        {
            "seq": 4,
            "kind": "debate_round_started",
            "payload": {"round": 1},
            "ts": "2026-07-15T02:20:46.000Z",
        },
        {
            "seq": 5,
            "kind": "debate_result",
            "payload": {"rounds": 1},
            "ts": "2026-07-15T02:20:47.000Z",
        },
        {
            "seq": 6,
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "td", "tool_name": "debate", "run_id": "cap"},
            "ts": "2026-07-15T02:20:48.000Z",
        },
        {
            "seq": 7,
            "kind": "run_completed",
            "payload": {"run_id": "cap"},
            "ts": "2026-07-15T02:20:58.000Z",
        },
        # turn-level process timeline drives reasoning placement + content split
        {
            "seq": 10,
            "kind": "process_reasoning",
            "payload": {"kind": "reasoning", "text": "先搜索案件"},
            "ts": None,
        },
        {
            "seq": 11,
            "kind": "process_tool",
            "payload": {"kind": "tool", "tool_name": "web_search"},
            "ts": None,
        },
        {
            "seq": 12,
            "kind": "process_reasoning",
            "payload": {"kind": "reasoning", "text": "该不该组队辩论"},
            "ts": None,
        },
        {
            "seq": 13,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "案情简介正文"},
            "ts": None,
        },
        {
            "seq": 14,
            "kind": "process_team_preview",
            "payload": {"kind": "team_preview"},
            "ts": None,
        },
        {
            "seq": 15,
            "kind": "process_reasoning",
            "payload": {"kind": "reasoning", "text": "辩论已收敛"},
            "ts": None,
        },
        {
            "seq": 16,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "最终汇总正文"},
            "ts": None,
        },
    ]
    content = "案情简介正文" + "\n\n" + "最终汇总正文"
    events = build_tape_events(
        rows,
        captain_content=content,
        captain_reasoning="unused-fallback",
        chunk_size=64,
        chunk_gap_ms=10,
    )

    def concat(kind: str) -> str:
        return "".join(
            (e["payload"].get("delta") or "") for e in events if e["kind"] == kind
        )

    # Reasoning byte fidelity == process_reasoning concat, positioned (not one blob).
    assert concat("reasoning_delta") == "先搜索案件该不该组队辩论辩论已收敛"
    # Content split on the true boundary is lossless (intro = the whole case brief).
    assert concat("content_delta") == content

    kinds = [e["kind"] for e in events]
    web_i = kinds.index("tool_use_start")
    preview_i = kinds.index("team_preview_required")
    debate_end_i = next(
        i
        for i, e in enumerate(events)
        if e["kind"] == "tool_use_end"
        and (e["payload"] or {}).get("tool_name") == "debate"
    )
    done_i = kinds.index("run_completed")
    intro_i = kinds.index("content_delta")

    def first_reasoning(needle: str) -> int:
        return next(
            i
            for i, e in enumerate(events)
            if e["kind"] == "reasoning_delta" and needle in (e["payload"].get("delta") or "")
        )

    def first_wrap_content() -> int:
        return next(
            i
            for i, e in enumerate(events)
            if e["kind"] == "content_delta"
            and "最终汇总" in (e["payload"].get("delta") or "")
        )

    # 检索思考在工具前；组队思考+案情简介在开工卡前；汇总在辩论 tool 结束后、完成前。
    assert first_reasoning("先搜索") < web_i
    assert first_reasoning("组队") < intro_i < preview_i
    wrap_r = first_reasoning("收敛")
    wrap_c = first_wrap_content()
    assert debate_end_i < wrap_r < wrap_c < done_i
    # Closing window is filled (not clumped on the tool_use_end ms).
    assert int(events[wrap_r]["t_ms"]) >= int(events[debate_end_i]["t_ms"])
    assert int(events[wrap_c]["t_ms"]) < int(events[done_i]["t_ms"])


def test_export_reasoning_fallback_without_process_timeline():
    """No process_reasoning in the journal → captain_reasoning replays in the closing
    window after debate_result (legacy behaviour, keeps old tapes exportable)."""
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {"run_id": "cap", "kind": "captain"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "debate_result",
            "payload": {"rounds": 1},
            "ts": "2026-07-15T02:20:47.000Z",
        },
        {
            "seq": 2,
            "kind": "run_completed",
            "payload": {"run_id": "cap"},
            "ts": "2026-07-15T02:20:57.000Z",
        },
    ]
    events = build_tape_events(
        rows, captain_reasoning="整段思考", chunk_size=64, chunk_gap_ms=10
    )
    kinds = [e["kind"] for e in events]
    assert kinds.index("debate_result") < kinds.index("reasoning_delta") < kinds.index(
        "run_completed"
    )
    assert (
        "".join(
            (e["payload"].get("delta") or "")
            for e in events
            if e["kind"] == "reasoning_delta"
        )
        == "整段思考"
    )


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


@pytest.mark.asyncio
async def test_replaying_same_tape_twice_remints_distinct_checkpoints(
    monkeypatch, tmp_path: Path
):
    """同一磁带连放两次：开工卡两次都发出，且 checkpoint 身份互不相同、均非录制 id。

    桌面 InteractionStore 以 interaction id 为跨会话全局键（已 resolved 不复活、pending
    首见保留）——若回放复用录制 id，同一桌面进程内第二次回放的开工卡会被静默吞掉。
    挂起帧与 resume 结算必须与发出的卡片共用同一铸造 id。
    """
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import (
        continue_tape_turn,
        play_tape_events,
        replay_checkpoint_id,
    )
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
                "checkpoint_id": "cp-recorded",
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
        {"kind": "content_delta", "payload": {"delta": "wrap"}, "t_ms": 200},
    ]
    tape_path = tmp_path / "twice.json"
    tape_path.write_text(
        json.dumps({"version": 1, "meta": {}, "events": events}, ensure_ascii=False),
        encoding="utf-8",
    )

    emitted: list[str] = []
    for i, message_id in enumerate(("msg-a", "msg-b")):
        conversation_id = f"conv-{i}"
        binding = TapeBinding(
            conversation_id=conversation_id,
            tape_path=tape_path,
            speed=100.0,
            max_gap_ms=50,
        )
        sink = EventSink(conversation_id=conversation_id, message_id=message_id)
        writer = TurnJournalWriter(
            turn_id=message_id, conversation_id=conversation_id, trace_id="t" * 32
        )
        result = await play_tape_events(
            sink=sink,
            events=events,
            start_index=0,
            binding=binding,
            message_id=message_id,
            conversation_id=conversation_id,
            user_id="u",
            user_message="go",
            folder_id=None,
            journal_writer=writer,
        )
        assert result["finish_reason"] is FinishReason.PAUSED
        card = next(
            e for e in sink._history if e.type is EventType.TEAM_PREVIEW_REQUIRED
        )
        emitted.append(str(card.payload["checkpoint_id"]))

    # 两次都出卡；身份互不相同、不等于录制 id；确定性铸造（同回合可重导出）。
    assert len(emitted) == 2
    assert emitted[0] != emitted[1]
    assert "cp-recorded" not in emitted
    assert emitted[0] == replay_checkpoint_id("cp-recorded", message_id="msg-a")
    assert emitted[1] == replay_checkpoint_id("cp-recorded", message_id="msg-b")

    # 挂起帧与卡片同 id；resume 结算沿用同一 id（不回落到录制 id）。
    assert [s.checkpoint_id for s in saved] == emitted
    sink2 = EventSink(conversation_id="conv-0", message_id="msg-a")
    result2 = await continue_tape_turn(
        suspension=saved[0],
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE, note=""),
        sink=sink2,
        folder_id=None,
        trace_id="t" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    resolved = next(
        e for e in sink2._history if e.type is EventType.TEAM_PREVIEW_RESOLVED
    )
    assert resolved.payload["checkpoint_id"] == emitted[0]


@pytest.mark.asyncio
async def test_tape_cancel_salvages_incomplete_turn(monkeypatch):
    """磁带回放中途被取消（断流/停服）走 salvage 收口，不留 status=running 僵尸行。"""
    import asyncio
    from types import SimpleNamespace

    from agentcore.conversation import turn_runner
    from agentcore.demo_tape import hooks as tape_hooks

    salvaged: list[dict] = []

    async def fake_placeholder(**kwargs):
        return None

    def fake_salvage(**kwargs):
        salvaged.append(kwargs)

    async def cancelled_tape(**kwargs):
        raise asyncio.CancelledError

    monkeypatch.setattr(turn_runner, "create_assistant_placeholder", fake_placeholder)
    monkeypatch.setattr(turn_runner, "salvage_incomplete_turn", fake_salvage)
    monkeypatch.setattr(tape_hooks, "run_tape_turn_if_bound", cancelled_tape)

    sink = EventSink()
    monkeypatch.setattr(
        sink, "bind_content_checkpoint", lambda **kw: None, raising=False
    )
    with pytest.raises(asyncio.CancelledError):
        await turn_runner.run_and_persist(
            conversation_id="conv-x",
            user_message="go",
            user_id="u1",
            folder_id=None,
            sink=sink,
            history=[],
            attachments=None,
            backend=SimpleNamespace(location="server"),
            llm_credentials=None,
        )
    assert len(salvaged) == 1
    assert salvaged[0]["conversation_id"] == "conv-x"
    assert salvaged[0]["message_id"]


def test_captain_run_id_finds_first_captain_run():
    from agentcore.demo_tape.player import _captain_run_id

    assert (
        _captain_run_id(
            [
                {"kind": "message_start", "payload": {}},
                {"kind": "run_started", "payload": {"run_id": "cap1", "kind": "captain"}},
                {"kind": "run_started", "payload": {"run_id": "w1", "kind": "agent"}},
            ]
        )
        == "cap1"
    )
    # No captain run → empty (nothing to normalize).
    assert _captain_run_id([{"kind": "run_started", "payload": {"run_id": "w1"}}]) == ""


@pytest.mark.asyncio
async def test_player_inlines_captain_tools_by_stripping_run_id(monkeypatch):
    """CEO self-tools (run_id == captain run) replay inline (run_id dropped) so the
    search phase renders instead of a silent「正在思考」; worker tools keep run_id."""
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import play_tape_events
    from agentcore.runtime.journal.writer import TurnJournalWriter

    async def fake_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr(player_mod.asyncio, "sleep", fake_sleep)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    events = [
        {"kind": "run_started", "payload": {"run_id": "cap1", "kind": "captain"}, "t_ms": 0},
        {
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "arguments": {}, "run_id": "cap1"},
            "t_ms": 100,
        },
        {
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "t1", "tool_name": "web_search", "run_id": "cap1"},
            "t_ms": 200,
        },
        {"kind": "run_started", "payload": {"run_id": "w1", "kind": "agent"}, "t_ms": 300},
        {
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t2", "tool_name": "read_url", "arguments": {}, "run_id": "w1"},
            "t_ms": 400,
        },
        {"kind": "content_delta", "payload": {"delta": "done"}, "t_ms": 500},
    ]
    binding = TapeBinding(
        conversation_id="c", tape_path=Path("unused.json"), speed=1.0, max_gap_ms=50
    )
    sink = EventSink(conversation_id="c", message_id="m")
    writer = TurnJournalWriter(turn_id="m", conversation_id="c", trace_id="t" * 32)
    await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="m",
        conversation_id="c",
        user_id="u",
        user_message="go",
        folder_id=None,
        journal_writer=writer,
    )
    starts = {
        e.payload.get("tool_name"): e.payload
        for e in sink._history
        if e.type is EventType.TOOL_USE_START
    }
    # CEO's own web_search: run_id stripped → turn-level inline step.
    assert "run_id" not in starts["web_search"]
    # Worker's read_url: run_id preserved → its own run node in the graph.
    assert starts["read_url"].get("run_id") == "w1"
    ends = [e.payload for e in sink._history if e.type is EventType.TOOL_USE_END]
    assert all("run_id" not in p for p in ends if p.get("tool_name") == "web_search")
    # Rendering outcome: the CEO's web_search is now a turn-level process step.
    inline_tools = [s for s in sink._process if s.get("kind") == "tool"]
    assert any(s.get("tool_name") == "web_search" for s in inline_tools)
    assert all(s.get("tool_name") != "read_url" for s in inline_tools)


def test_delegation_compose_chars_counts_debate_arguments():
    from agentcore.demo_tape.export import delegation_compose_chars

    payload = {
        "motion": "abcd",
        "sides": [
            {"name": "AA", "stance": "xyz"},
            {"name": "BB", "stance": "z"},
        ],
        "workers": [{"role": "R", "task": "TT"}],
    }
    # motion(4) + AA(2)+xyz(3) + BB(2)+z(1) + R(1)+TT(2) = 15
    assert delegation_compose_chars(payload) == 15
    assert delegation_compose_chars({}) == 0


def test_export_spreads_synthetic_deltas_across_window():
    """合成 delta 在前锚→后锚窗口内均匀铺开，不再挤到同一毫秒或末尾 35ms 连打。"""
    rows = [
        {
            "seq": 0,
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "t1", "tool_name": "read_url"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t2", "tool_name": "debate"},
            "ts": "2026-07-15T02:21:05.000Z",  # +23s
        },
        {
            "seq": 2,
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp",
                "form": "debate",
                "primitive": "debate",
                "motion": "议题" * 20,
                "sides": [{"key": "a", "name": "A", "stance": "站" * 20}],
                "workers": [],
            },
            "ts": "2026-07-15T02:21:07.000Z",
        },
        {
            "seq": 10,
            "kind": "process_reasoning",
            "payload": {"kind": "reasoning", "text": "该不该组队" * 30},
            "ts": None,
        },
        {
            "seq": 11,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "案情简介正文" * 20},
            "ts": None,
        },
        {
            "seq": 12,
            "kind": "process_team_preview",
            "payload": {"kind": "team_preview"},
            "ts": None,
        },
    ]
    content = "案情简介正文" * 20
    events = build_tape_events(
        rows, captain_content=content, chunk_size=12, chunk_gap_ms=35
    )
    orch_i = next(
        i
        for i, e in enumerate(events)
        if e["kind"] == "tool_use_start"
        and (e["payload"] or {}).get("tool_name") == "debate"
    )
    end_t = int(events[orch_i]["t_ms"])
    start_t = 0  # tool_use_end at origin
    assert end_t == 23_000

    reasoning = [e for e in events[:orch_i] if e["kind"] == "reasoning_delta"]
    intro = [e for e in events[:orch_i] if e["kind"] == "content_delta"]
    progress = [e for e in events[:orch_i] if e["kind"] == "tool_progress"]
    assert reasoning and intro and progress

    r_ts = [int(e["t_ms"]) for e in reasoning]
    i_ts = [int(e["t_ms"]) for e in intro]
    p_ts = [int(e["t_ms"]) for e in progress]
    # Spread across the 23s window — not clamped to one millisecond.
    assert max(r_ts) - min(r_ts) > 1000
    assert max(i_ts) - min(i_ts) > 200 or len(intro) == 1
    assert min(r_ts) >= start_t
    assert max(p_ts) <= end_t
    # Causal order: reasoning → intro → compose → orch tool.
    assert max(r_ts) <= min(i_ts)
    assert max(i_ts) <= min(p_ts)
    assert max(p_ts) <= end_t
    assert all(progress[0]["payload"]["tool_name"] == "debate" for _ in [0])
    chars = [p["payload"]["chars"] for p in progress]
    assert chars == sorted(chars) and chars[-1] > chars[0]
    # Byte fidelity.
    assert "".join(e["payload"]["delta"] for e in reasoning) == "该不该组队" * 30
    assert "".join(e["payload"]["delta"] for e in intro) == content


def test_export_rebuilds_worker_run_deltas_from_final_and_process():
    """message_final + run_process_* → run_*_delta，字节保真且落在 run 窗口内。"""
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {
                "run_id": "w1",
                "agent_id": "agent-w1",
                "kind": "agent",
            },
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {
                "tool_call_id": "tc1",
                "tool_name": "web_search",
                "run_id": "w1",
            },
            "ts": "2026-07-15T02:20:50.000Z",
        },
        {
            "seq": 2,
            "kind": "tool_use_end",
            "payload": {
                "tool_call_id": "tc1",
                "tool_name": "web_search",
                "run_id": "w1",
            },
            "ts": "2026-07-15T02:20:52.000Z",
        },
        {
            "seq": 3,
            "kind": "run_completed",
            "payload": {"run_id": "w1", "agent_id": "agent-w1"},
            "ts": "2026-07-15T02:21:42.000Z",  # +60s from start
        },
        {
            "seq": 20,
            "kind": "run_process_reasoning",
            "payload": {"run_id": "w1", "kind": "reasoning", "text": "先想清楚"},
            "ts": None,
        },
        {
            "seq": 21,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "web_search"},
            "ts": None,
        },
        {
            "seq": 22,
            "kind": "run_process_content",
            "payload": {"run_id": "w1", "kind": "content", "text": "最终意见陈述"},
            "ts": None,
        },
        {
            "seq": 30,
            "kind": "message_final",
            "payload": {
                "run_id": "w1",
                "content": "最终意见陈述",
                "reasoning": "先想清楚",
                "phase": "completed",
            },
            "ts": None,
        },
    ]
    events = build_tape_events(rows, chunk_size=4, chunk_gap_ms=35)
    kinds = [e["kind"] for e in events]
    assert "run_reasoning_delta" in kinds
    assert "run_output_delta" in kinds

    started = next(i for i, e in enumerate(events) if e["kind"] == "run_started")
    tool_i = next(i for i, e in enumerate(events) if e["kind"] == "tool_use_start")
    completed = next(i for i, e in enumerate(events) if e["kind"] == "run_completed")
    run_slice = events[started : completed + 1]

    reasoning = [e for e in run_slice if e["kind"] == "run_reasoning_delta"]
    output = [e for e in run_slice if e["kind"] == "run_output_delta"]
    assert reasoning and output
    assert "".join(e["payload"]["delta"] for e in reasoning) == "先想清楚"
    assert "".join(e["payload"]["delta"] for e in output) == "最终意见陈述"
    for e in reasoning + output:
        assert e["payload"]["run_id"] == "w1"
        assert e["payload"]["agent_id"] == "agent-w1"
        assert int(events[started]["t_ms"]) <= int(e["t_ms"]) <= int(
            events[completed]["t_ms"]
        )
    # Process order: reasoning beats are eligible from gap0; content only after the tool.
    # Capacity packing may overflow some reasoning into later gaps, but content must not
    # precede the tool anchor in wall-clock time.
    assert min(int(e["t_ms"]) for e in output) >= int(events[tool_i]["t_ms"])


def test_export_worker_deltas_pack_by_gap_capacity_not_zero_width_flush():
    """文本在 process 中部、工具堆尾：不硬塞零宽并发锚，末段大窗要吃满文本拍。"""
    # Window: start@0 → early tool@10s → three concurrent tools@20s → last tool@30s → done@90s
    # Process: small reasoning → early tool → BIG mid text → trailing tools.
    # Old hard-flush dumped the mid text into the zero-width concurrent gaps.
    base = "2026-07-15T02:20:42.000Z"
    mid_reasoning = ("深度思考段落。" * 40)  # many chunks
    mid_content = ("正式意见正文。" * 15)
    late_reasoning = ("补充推理收尾。" * 40)
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {"run_id": "w1", "agent_id": "a1", "kind": "agent"},
            "ts": base,
        },
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t0", "tool_name": "web_search", "run_id": "w1"},
            "ts": "2026-07-15T02:20:52.000Z",  # +10s
        },
        {
            "seq": 2,
            "kind": "tool_use_end",
            "payload": {"tool_call_id": "t0", "tool_name": "web_search", "run_id": "w1"},
            "ts": "2026-07-15T02:20:53.000Z",
        },
        # Concurrent same-ms tool pile (zero-width gaps).
        {
            "seq": 3,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t1", "tool_name": "read_url", "run_id": "w1"},
            "ts": "2026-07-15T02:21:02.000Z",  # +20s
        },
        {
            "seq": 4,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t2", "tool_name": "read_url", "run_id": "w1"},
            "ts": "2026-07-15T02:21:02.000Z",
        },
        {
            "seq": 5,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t3", "tool_name": "read_url", "run_id": "w1"},
            "ts": "2026-07-15T02:21:02.000Z",
        },
        {
            "seq": 6,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "t4", "tool_name": "read_url", "run_id": "w1"},
            "ts": "2026-07-15T02:21:12.000Z",  # +30s last tool
        },
        {
            "seq": 7,
            "kind": "run_completed",
            "payload": {"run_id": "w1", "agent_id": "a1"},
            "ts": "2026-07-15T02:22:12.000Z",  # +90s (60s after last tool)
        },
        {
            "seq": 20,
            "kind": "run_process_reasoning",
            "payload": {"run_id": "w1", "kind": "reasoning", "text": "先搜一下"},
            "ts": None,
        },
        {
            "seq": 21,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "web_search"},
            "ts": None,
        },
        {
            "seq": 22,
            "kind": "run_process_reasoning",
            "payload": {"run_id": "w1", "kind": "reasoning", "text": mid_reasoning},
            "ts": None,
        },
        {
            "seq": 23,
            "kind": "run_process_content",
            "payload": {"run_id": "w1", "kind": "content", "text": mid_content},
            "ts": None,
        },
        {
            "seq": 24,
            "kind": "run_process_reasoning",
            "payload": {"run_id": "w1", "kind": "reasoning", "text": late_reasoning},
            "ts": None,
        },
        {
            "seq": 25,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "read_url"},
            "ts": None,
        },
        {
            "seq": 26,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "read_url"},
            "ts": None,
        },
        {
            "seq": 27,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "read_url"},
            "ts": None,
        },
        {
            "seq": 28,
            "kind": "run_process_tool",
            "payload": {"run_id": "w1", "kind": "tool", "tool_name": "read_url"},
            "ts": None,
        },
        {
            "seq": 30,
            "kind": "message_final",
            "payload": {
                "run_id": "w1",
                "content": mid_content,
                "reasoning": "先搜一下" + mid_reasoning + late_reasoning,
                "phase": "completed",
            },
            "ts": None,
        },
    ]
    events = build_tape_events(rows, chunk_size=12, chunk_gap_ms=35)
    started = next(e for e in events if e["kind"] == "run_started")
    completed = next(e for e in events if e["kind"] == "run_completed")
    deltas = [
        e
        for e in events
        if e["kind"] in ("run_output_delta", "run_reasoning_delta")
        and (e["payload"] or {}).get("run_id") == "w1"
    ]
    assert deltas
    # Byte fidelity.
    assert "".join(
        e["payload"]["delta"] for e in deltas if e["kind"] == "run_reasoning_delta"
    ) == ("先搜一下" + mid_reasoning + late_reasoning)
    assert "".join(
        e["payload"]["delta"] for e in deltas if e["kind"] == "run_output_delta"
    ) == mid_content

    ts = [int(e["t_ms"]) for e in deltas]
    from collections import Counter

    clump = max(Counter(ts).values())
    assert clump / len(ts) <= 0.30, f"clumped {clump}/{len(ts)} beats on one t_ms"

    start_t = int(started["t_ms"])
    end_t = int(completed["t_ms"])
    span = end_t - start_t
    tail_dead = end_t - max(ts)
    assert tail_dead <= max(5_000, span * 0.10), (
        f"dead tail {tail_dead}ms exceeds budget (span={span}ms)"
    )
    assert min(ts) >= start_t and max(ts) <= end_t


@pytest.mark.asyncio
async def test_player_skip_kinds_do_not_advance_pacing_clock(monkeypatch):
    """resume 后 turn_paused / resolved 等 skip 事件不睡、不推进时钟 → 首拍 sleep=0。"""
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

    # Simulate post-pause resume: skip events carry the recorder's hesitation gap,
    # then the first real event is 11s later on the tape clock.
    events = [
        {"kind": "turn_paused", "payload": {"checkpoint_id": "cp"}, "t_ms": 34_000},
        {
            "kind": "team_preview_resolved",
            "payload": {"decision": "continue"},
            "t_ms": 34_000,
        },
        {
            "kind": "run_started",
            "payload": {"run_id": "w1", "kind": "agent"},
            "t_ms": 45_000,
        },
        {
            "kind": "run_output_delta",
            "payload": {"run_id": "w1", "agent_id": "w1", "delta": "hi"},
            "t_ms": 45_100,
        },
    ]
    binding = TapeBinding(
        conversation_id="c",
        tape_path=Path("unused.json"),
        speed=1.0,
        max_gap_ms=600_000,
    )
    sink = EventSink(conversation_id="c", message_id="m")
    writer = TurnJournalWriter(turn_id="m", conversation_id="c", trace_id="t" * 32)
    await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="m",
        conversation_id="c",
        user_id="u",
        user_message="go",
        folder_id=None,
        journal_writer=writer,
        emit_message_start=False,
    )
    # Skip + first real event: no sleep (prev_t stays None → gap 0, delay not awaited).
    # Only the 100ms gap between the two real events is slept.
    assert sleeps == [pytest.approx(0.1)]
    assert sum(sleeps) == pytest.approx(0.1)


def test_export_injects_delegation_composing_before_orch_tool():
    """委派 tool_progress 落在简介之后、编排工具 start 之前（导出层，非 player）。"""
    rows = [
        {
            "seq": 0,
            "kind": "run_started",
            "payload": {"run_id": "cap", "kind": "captain"},
            "ts": "2026-07-15T02:20:42.000Z",
        },
        {
            "seq": 1,
            "kind": "tool_use_start",
            "payload": {"tool_call_id": "td", "tool_name": "debate"},
            "ts": "2026-07-15T02:21:00.000Z",
        },
        {
            "seq": 2,
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp1",
                "form": "debate",
                "primitive": "debate",
                "motion": "本案一审判决是否应被维持？",
                "sides": [
                    {"key": "lv", "name": "LV方", "stance": "判决正确。" * 10},
                    {"key": "m", "name": "茉莉奶白方", "stance": "判决值得商榷。" * 10},
                ],
                "workers": [],
                "tools": [],
                "max_rounds": 4,
                "thorough": True,
            },
            "ts": "2026-07-15T02:21:02.000Z",
        },
        {
            "seq": 10,
            "kind": "process_content",
            "payload": {"kind": "content", "text": "案情简介全文"},
            "ts": None,
        },
        {
            "seq": 11,
            "kind": "process_team_preview",
            "payload": {"kind": "team_preview"},
            "ts": None,
        },
    ]
    events = build_tape_events(
        rows, captain_content="案情简介全文", chunk_size=8, chunk_gap_ms=35
    )
    kinds = [e["kind"] for e in events]
    assert "tool_progress" in kinds
    assert kinds.index("content_delta") < kinds.index("tool_progress")
    assert kinds.index("tool_progress") < kinds.index("tool_use_start")
    assert kinds.index("tool_use_start") < kinds.index("team_preview_required")
    progresses = [e for e in events if e["kind"] == "tool_progress"]
    assert all(p["payload"]["tool_name"] == "debate" for p in progresses)
    chars = [p["payload"]["chars"] for p in progresses]
    assert chars == sorted(chars) and chars[-1] > chars[0]
