"""Unit tests for demo tape recording / export / pacing / player (dev-only)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentcore.demo_tape.binding import conversation_is_cloud, write_binding
from agentcore.demo_tape.export import (
    TapeExportRefusedError,
    assert_export_allowed,
    build_tape_from_recording,
    load_tape,
    write_tape,
)
from agentcore.demo_tape.identity import (
    INTERACTION_ID_KEYS,
    remint_interaction_ids,
    replay_interaction_id,
)
from agentcore.demo_tape.pacing import sleep_ms_for_gap
from agentcore.demo_tape.sanitize import (
    DEMO_MEMORY_PLACEHOLDER,
    SYNTHETIC_MEMORY_RULES,
    IngestScanError,
    assert_ingest_clean,
    sanitize_and_scan_events,
    sanitize_memory_in_text,
    scan_events_for_ingest_residue,
)
from agentcore.demo_tape.schema import (
    CLIENT_TOOL_REQUIRED_KINDS,
    DEMO_TAPE_FRAME_KEY,
    RECORDING_FORMAT_VERSION,
    TAPE_EXCLUDED_KINDS,
    TAPE_FORMAT_VERSION,
    TAPE_UNWIRED_PAUSE_KINDS,
    event_timestamp,
    event_type,
    is_demo_tape_frame,
    normalize_tape_event,
)
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType, FinishReason
from agentcore.runtime.events.types import SSEEvent
from agentcore.runtime.suspension import TeamPreviewSuspension
from scripts.demo_tape_bind import build_parser


def _ev(kind: str, payload: dict | None = None) -> SSEEvent:
    return SSEEvent(type=EventType(kind), payload=payload or {})


def test_tape_excluded_kinds_cut_lifecycle_settlements_and_client_ops():
    # Turn lifecycle is the player's own; settlements are re-emitted live.
    assert "message_start" in TAPE_EXCLUDED_KINDS
    assert "message_end" in TAPE_EXCLUDED_KINDS
    assert "team_preview_resolved" in TAPE_EXCLUDED_KINDS
    # followups_generated stays cut — chips ride meta.followups, not the event stream.
    assert "followups_generated" in TAPE_EXCLUDED_KINDS
    # Client-tool requests must never replay (real side effects on the desktop).
    assert "workspace_op_required" in TAPE_EXCLUDED_KINDS
    assert "desktop_notify_required" in TAPE_EXCLUDED_KINDS
    # Content / liveliness stays.
    assert "content_delta" not in TAPE_EXCLUDED_KINDS
    assert "tool_progress" not in TAPE_EXCLUDED_KINDS
    assert "team_preview_required" not in TAPE_EXCLUDED_KINDS


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


# ── 回放身份 ≠ 录制身份 ────────────────────────────────────────────────────


def test_remint_interaction_ids_maps_all_interaction_keys_deterministically():
    events = [
        {"kind": "team_preview_required", "payload": {"checkpoint_id": "cp-1", "motion": "m"}},
        {"kind": "approval_required", "payload": {"approval_id": "ap-1"}},
        {"kind": "question_posted", "payload": {"ask_id": "ask-1"}},
        {"kind": "run_escalation", "payload": {"escalation_id": "esc-1"}},
        {"kind": "interaction_orphaned", "payload": {"interaction_id": "cp-1"}},
        # Execution identities stay AS RECORDED (message-scoped + structured strings).
        {"kind": "run_started", "payload": {"run_id": "debate_x_r1_lv", "kind": "agent"}},
        {"kind": "content_delta", "payload": {"delta": "hi"}},
    ]
    out = remint_interaction_ids(events, message_id="m1")
    by_kind = {e["kind"]: e["payload"] for e in out}

    for kind, key, original in (
        ("team_preview_required", "checkpoint_id", "cp-1"),
        ("approval_required", "approval_id", "ap-1"),
        ("question_posted", "ask_id", "ask-1"),
        ("run_escalation", "escalation_id", "esc-1"),
    ):
        minted = by_kind[kind][key]
        assert minted != original
        assert minted == replay_interaction_id(original, message_id="m1")

    # Same recorded id ⇒ same minted id (orphan still targets the reminted card).
    assert (
        by_kind["interaction_orphaned"]["interaction_id"]
        == by_kind["team_preview_required"]["checkpoint_id"]
    )
    # Untouched events pass through unchanged (payload identity preserved).
    assert by_kind["run_started"]["run_id"] == "debate_x_r1_lv"
    assert out[6]["payload"] is events[6]["payload"]
    # Non-payload fields survive on touched events.
    assert by_kind["team_preview_required"]["motion"] == "m"
    # A different turn mints different ids.
    assert replay_interaction_id("cp-1", message_id="m1") != replay_interaction_id(
        "cp-1", message_id="m2"
    )
    assert {"checkpoint_id", "approval_id", "ask_id"}.issubset(INTERACTION_ID_KEYS)


# ── recording → tape builder ─────────────────────────────────────────────


def test_build_tape_from_recording_stitches_segments_and_cuts_excluded():
    # Input uses legacy kind/ts dialect — cut must still work and emit type/timestamp.
    recording = {
        "version": 1,
        "kind": "demo_tape_recording",
        "meta": {"conversation_id": "conv-1", "message_id": "msg-1"},
        "segments": [
            {
                "wall_t0_ms": 1_000_000,
                "events": [
                    {"kind": "message_start", "payload": {}, "ts": None, "t_ms": 0},
                    {"kind": "reasoning_delta", "payload": {"delta": "想"}, "ts": None, "t_ms": 10},
                    {"kind": "content_delta", "payload": {"delta": "简介"}, "ts": None, "t_ms": 500},
                    {
                        "kind": "team_preview_required",
                        "payload": {"checkpoint_id": "cp-src"},
                        "ts": None,
                        "t_ms": 900,
                    },
                    {
                        "kind": "message_end",
                        "payload": {"finish_reason": "paused"},
                        "ts": None,
                        "t_ms": 910,
                    },
                ],
            },
            {
                # 13s later on the wall clock — the human decision gap survives.
                "wall_t0_ms": 1_013_000,
                "events": [
                    {
                        "kind": "team_preview_resolved",
                        "payload": {"checkpoint_id": "cp-src", "decision": "continue"},
                        "ts": None,
                        "t_ms": 0,
                    },
                    {
                        "kind": "run_output_delta",
                        "payload": {"run_id": "w1", "delta": "观点"},
                        "ts": None,
                        "t_ms": 100,
                    },
                    {"kind": "content_delta", "payload": {"delta": "汇总"}, "ts": None, "t_ms": 400},
                    {
                        "kind": "message_end",
                        "payload": {"finish_reason": "end_turn"},
                        "ts": None,
                        "t_ms": 450,
                    },
                ],
            },
        ],
    }
    doc = build_tape_from_recording(recording, meta={"title": "t"}, user_prompt="go")
    assert doc["version"] == TAPE_FORMAT_VERSION
    types = [e["type"] for e in doc["events"]]
    assert "message_start" not in types
    assert "message_end" not in types
    assert "team_preview_resolved" not in types
    assert types == [
        "reasoning_delta",
        "content_delta",
        "team_preview_required",
        "run_output_delta",
        "content_delta",
    ]
    assert all("kind" not in e and "ts" not in e for e in doc["events"])
    assert all("timestamp" in e for e in doc["events"])
    assert "followups" not in doc["meta"]  # no followups_generated in this fixture
    # Recording identities stay verbatim on the tape (the PLAYER remints per replay).
    preview = next(e for e in doc["events"] if e["type"] == "team_preview_required")
    assert preview["payload"]["checkpoint_id"] == "cp-src"
    # Global timeline: segment 2 anchored 13s after segment 1's start.
    t = {(e["type"], e["payload"].get("delta")): e["t_ms"] for e in doc["events"]}
    assert t[("reasoning_delta", "想")] == 10
    assert t[("team_preview_required", None)] == 900
    assert t[("run_output_delta", "观点")] == 13_100
    assert t[("content_delta", "汇总")] == 13_400
    assert doc["meta"]["user_prompt"] == "go"
    assert doc["meta"]["title"] == "t"
    assert doc["meta"]["source_message_id"] == "msg-1"
    assert doc["meta"]["event_count"] == 5
    assert doc["meta"]["duration_ms"] == 13_400
    # t_ms stays monotonic even under wall-clock jitter.
    ts = [e["t_ms"] for e in doc["events"]]
    assert ts == sorted(ts)


def test_build_tape_from_recording_clamps_wall_clock_jitter():
    recording = {
        "meta": {"conversation_id": "c", "message_id": "m"},
        "segments": [
            {
                "wall_t0_ms": 2_000,
                "events": [
                    {"kind": "content_delta", "payload": {"delta": "a"}, "t_ms": 0},
                    {"kind": "content_delta", "payload": {"delta": "b"}, "t_ms": 500},
                ],
            },
            {
                # Wall clock stepped BACK (NTP jitter) — must not rewind t_ms.
                "wall_t0_ms": 1_900,
                "events": [
                    {"kind": "content_delta", "payload": {"delta": "c"}, "t_ms": 0},
                ],
            },
        ],
    }
    doc = build_tape_from_recording(recording, user_prompt="go")
    ts = [e["t_ms"] for e in doc["events"]]
    assert ts == sorted(ts)
    assert "".join(e["payload"]["delta"] for e in doc["events"]) == "abc"


def test_write_and_load_tape(tmp_path: Path):
    doc = build_tape_from_recording(
        {
            "meta": {"conversation_id": "c", "message_id": "m"},
            "segments": [
                {
                    "wall_t0_ms": 0,
                    "events": [
                        {"kind": "content_delta", "payload": {"delta": "hi"}, "t_ms": 0}
                    ],
                }
            ],
        },
        meta={"title": "t"},
        user_prompt="hi",
    )
    path = tmp_path / "t.json"
    write_tape(path, doc)
    loaded = load_tape(path)
    assert loaded["version"] == TAPE_FORMAT_VERSION
    assert loaded["meta"]["user_prompt"] == "hi"
    assert len(loaded["events"]) == 1
    assert loaded["events"][0]["type"] == "content_delta"
    assert "kind" not in loaded["events"][0]


# ── field dialect: contract type/timestamp + legacy kind/ts alias ─────────


def test_normalize_tape_event_aliases_legacy_kind_ts():
    legacy = {
        "kind": "content_delta",
        "payload": {"delta": "x"},
        "ts": "2026-07-16T00:00:00.000Z",
        "t_ms": 10,
    }
    norm = normalize_tape_event(legacy)
    assert norm == {
        "type": "content_delta",
        "payload": {"delta": "x"},
        "timestamp": "2026-07-16T00:00:00.000Z",
        "t_ms": 10,
    }
    assert event_type(legacy) == "content_delta"
    assert event_timestamp(legacy) == "2026-07-16T00:00:00.000Z"
    # Contract fields win when both dialects are present.
    mixed = {"type": "run_started", "kind": "content_delta", "timestamp": "a", "ts": "b"}
    assert event_type(mixed) == "run_started"
    assert event_timestamp(mixed) == "a"


def test_load_tape_alias_compat_legacy_kind_ts_without_rewriting_disk(tmp_path: Path):
    """Stock v1 tapes (kind/ts) load/play via alias; on-disk file is not rewritten."""
    path = tmp_path / "legacy.json"
    on_disk = {
        "version": 1,
        "meta": {"user_prompt": "go", "title": "legacy"},
        "events": [
            {
                "kind": "run_started",
                "payload": {"run_id": "c1", "kind": "captain"},
                "ts": "2026-07-16T01:00:00.000Z",
                "t_ms": 0,
            },
            {
                "kind": "content_delta",
                "payload": {"delta": "hi"},
                "ts": None,
                "t_ms": 50,
            },
        ],
    }
    path.write_text(json.dumps(on_disk, ensure_ascii=False), encoding="utf-8")
    loaded = load_tape(path)
    assert loaded["version"] == 1  # disk version preserved in memory
    assert [e["type"] for e in loaded["events"]] == ["run_started", "content_delta"]
    assert loaded["events"][0]["timestamp"] == "2026-07-16T01:00:00.000Z"
    assert loaded["events"][1]["timestamp"] is None
    assert all("kind" not in e and "ts" not in e for e in loaded["events"])
    # Stock file untouched (read-time compat only — no migration rewrite).
    raw = json.loads(path.read_text(encoding="utf-8"))
    assert raw["events"][0]["kind"] == "run_started"
    assert "type" not in raw["events"][0]


@pytest.mark.asyncio
async def test_player_plays_legacy_kind_ts_events(monkeypatch):
    """Player accepts raw legacy dialect without going through load_tape."""
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
        {
            "kind": "run_started",
            "payload": {"run_id": "c1", "kind": "captain"},
            "ts": "2026-07-16T02:00:00.000Z",
            "t_ms": 0,
        },
        {"kind": "content_delta", "payload": {"delta": "正文"}, "ts": None, "t_ms": 10},
    ]
    binding = TapeBinding(
        conversation_id="c", tape_path=Path("unused.json"), speed=1.0, max_gap_ms=50
    )
    sink = EventSink(conversation_id="c", message_id="m")
    writer = TurnJournalWriter(turn_id="m", conversation_id="c", trace_id="t" * 32)
    result = await play_tape_events(
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
    assert result["finish_reason"] is FinishReason.END_TURN
    assert result["content"] == "正文"
    assert EventType.RUN_STARTED in [e.type for e in sink._history]
    assert EventType.CONTENT_DELTA in [e.type for e in sink._history]


def test_build_tape_from_legacy_recording_emits_contract_fields():
    """Cutting a v1 kind/ts recording yields a v2 type/timestamp tape."""
    recording = {
        "version": 1,
        "kind": "demo_tape_recording",
        "meta": {"conversation_id": "c", "message_id": "m"},
        "segments": [
            {
                "wall_t0_ms": 0,
                "events": [
                    {
                        "kind": "content_delta",
                        "payload": {"delta": "a"},
                        "ts": "2026-07-16T03:00:00.000Z",
                        "t_ms": 0,
                    },
                    {
                        "kind": "message_end",
                        "payload": {"finish_reason": "end_turn"},
                        "ts": None,
                        "t_ms": 1,
                    },
                ],
            }
        ],
    }
    doc = build_tape_from_recording(recording, user_prompt="p")
    assert doc["version"] == TAPE_FORMAT_VERSION
    assert doc["events"] == [
        {
            "type": "content_delta",
            "payload": {"delta": "a"},
            "timestamp": "2026-07-16T03:00:00.000Z",
            "t_ms": 0,
        }
    ]


# ── recorder tap ─────────────────────────────────────────────────────────


def _install_recorder_at(monkeypatch, tmp_path: Path):
    from agentcore.config import settings
    from agentcore.demo_tape import recorder

    monkeypatch.setattr(
        settings, "demo_tape_recordings_dir", str(tmp_path / "recordings")
    )
    recorder.install_recorder()
    return recorder


def test_recorder_taps_bound_sinks_and_flushes_on_message_end(monkeypatch, tmp_path):
    from agentcore.runtime.events import message_end, message_start

    recorder = _install_recorder_at(monkeypatch, tmp_path)
    try:
        # Unbound sink (pre-bind route chrome) → not recorded.
        loose = EventSink()
        loose.emit(_ev("turn_saved", {"user_message_id": "u1"}))

        sink = EventSink(conversation_id="conv-r", message_id="msg-r")
        sink.emit(message_start("msg-r", conversation_id="conv-r"))
        sink.emit(_ev("content_delta", {"delta": "你好"}))
        sink.emit(message_end(FinishReason.PAUSED))
        path = recorder.recording_path("msg-r")
        assert path.exists()
        doc = recorder.load_recording(path)
        assert doc["version"] == RECORDING_FORMAT_VERSION
        assert doc["meta"]["conversation_id"] == "conv-r"
        segment = doc["segments"][0]
        types = [e["type"] for e in segment["events"]]
        assert types == ["message_start", "content_delta", "message_end"]
        assert all("kind" not in e and "timestamp" in e for e in segment["events"])
        # On-disk flush also uses contract fields (not just load-time normalize).
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["version"] == RECORDING_FORMAT_VERSION
        assert raw["segments"][0]["events"][0]["type"] == "message_start"
        assert "kind" not in raw["segments"][0]["events"][0]
        # Paused → recording stays open awaiting the resume leg.
        assert "msg-r" in recorder._recordings

        resume_sink = EventSink(conversation_id="conv-r", message_id="msg-r")
        resume_sink.emit(_ev("content_delta", {"delta": "继续"}))
        resume_sink.emit(message_end(FinishReason.END_TURN))
        doc = recorder.load_recording(path)
        assert len(doc["segments"]) == 2
        # Terminal → recording complete and dropped from memory.
        assert "msg-r" not in recorder._recordings
        # The unbound sink produced no recording file at all.
        files = sorted(p.name for p in recorder.recordings_dir().glob("*.json"))
        assert files == ["msg-r.json"]
    finally:
        recorder.uninstall_recorder()


def test_recorder_hydrates_flushed_segments_after_restart(monkeypatch, tmp_path):
    """Server restarted between the paused send leg and the resume leg: the resume
    leg must append to the flushed file, not overwrite it."""
    from agentcore.runtime.events import message_end

    recorder = _install_recorder_at(monkeypatch, tmp_path)
    try:
        sink = EventSink(conversation_id="conv-h", message_id="msg-h")
        sink.emit(_ev("content_delta", {"delta": "前段"}))
        sink.emit(message_end(FinishReason.PAUSED))
        # Simulate restart: in-memory state gone, file remains.
        recorder._recordings.clear()

        resume_sink = EventSink(conversation_id="conv-h", message_id="msg-h")
        resume_sink.emit(_ev("content_delta", {"delta": "后段"}))
        resume_sink.emit(message_end(FinishReason.END_TURN))

        doc = recorder.load_recording(recorder.recording_path("msg-h"))
        assert len(doc["segments"]) == 2
        deltas = [
            e["payload"].get("delta")
            for s in doc["segments"]
            for e in s["events"]
            if e["type"] == "content_delta"
        ]
        assert deltas == ["前段", "后段"]
    finally:
        recorder.uninstall_recorder()


def test_recorder_hydrates_legacy_kind_ts_segments_after_restart(monkeypatch, tmp_path):
    """Prior flushed v1 recording (kind/ts) still appends cleanly on resume."""
    from agentcore.runtime.events import message_end

    recorder = _install_recorder_at(monkeypatch, tmp_path)
    try:
        path = recorder.recording_path("msg-legacy")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "kind": "demo_tape_recording",
                    "meta": {
                        "conversation_id": "conv-l",
                        "message_id": "msg-legacy",
                    },
                    "segments": [
                        {
                            "wall_t0_ms": 1_000,
                            "events": [
                                {
                                    "kind": "content_delta",
                                    "payload": {"delta": "旧段"},
                                    "ts": None,
                                    "t_ms": 0,
                                },
                                {
                                    "kind": "message_end",
                                    "payload": {"finish_reason": "paused"},
                                    "ts": None,
                                    "t_ms": 1,
                                },
                            ],
                        }
                    ],
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )

        resume_sink = EventSink(conversation_id="conv-l", message_id="msg-legacy")
        resume_sink.emit(_ev("content_delta", {"delta": "新段"}))
        resume_sink.emit(message_end(FinishReason.END_TURN))

        doc = recorder.load_recording(path)
        assert len(doc["segments"]) == 2
        deltas = [
            e["payload"].get("delta")
            for s in doc["segments"]
            for e in s["events"]
            if e["type"] == "content_delta"
        ]
        assert deltas == ["旧段", "新段"]
        # Hydrated prior segment normalized in memory; new segment written as type/.
        raw = json.loads(path.read_text(encoding="utf-8"))
        assert raw["version"] == RECORDING_FORMAT_VERSION
        assert raw["segments"][0]["events"][0]["type"] == "content_delta"
        assert raw["segments"][1]["events"][0]["type"] == "content_delta"
    finally:
        recorder.uninstall_recorder()


def test_recorder_captures_post_turn_followups_after_terminal_message_end(
    monkeypatch, tmp_path
):
    """Terminal message_end flush+pops; followups_generated still lands on disk."""
    from agentcore.runtime.events import followups_generated, message_end, message_start

    recorder = _install_recorder_at(monkeypatch, tmp_path)
    try:
        sink = EventSink(conversation_id="conv-fu", message_id="msg-fu")
        sink.emit(message_start("msg-fu", conversation_id="conv-fu"))
        sink.emit(_ev("content_delta", {"delta": "答复"}))
        sink.emit(message_end(FinishReason.END_TURN))
        assert "msg-fu" not in recorder._recordings

        chips = ["建议一", "建议二", "建议三"]
        sink.emit(
            followups_generated(chips, conversation_id="conv-fu", message_id="msg-fu")
        )
        assert "msg-fu" not in recorder._recordings

        doc = recorder.load_recording(recorder.recording_path("msg-fu"))
        assert len(doc["segments"]) == 2
        types = [e["type"] for s in doc["segments"] for e in s["events"]]
        assert types[-1] == "followups_generated"
        assert doc["segments"][-1]["events"][-1]["payload"]["followups"] == chips
    finally:
        recorder.uninstall_recorder()


def test_build_tape_lifts_followups_generated_into_meta():
    recording = {
        "version": 2,
        "kind": "demo_tape_recording",
        "meta": {"conversation_id": "c", "message_id": "m"},
        "segments": [
            {
                "wall_t0_ms": 0,
                "events": [
                    {"type": "content_delta", "payload": {"delta": "hi"}, "timestamp": None, "t_ms": 0},
                    {
                        "type": "message_end",
                        "payload": {"finish_reason": "end_turn"},
                        "timestamp": None,
                        "t_ms": 1,
                    },
                ],
            },
            {
                "wall_t0_ms": 50,
                "events": [
                    {
                        "type": "followups_generated",
                        "payload": {
                            "conversation_id": "c",
                            "message_id": "m",
                            "followups": ["A", "B"],
                        },
                        "timestamp": None,
                        "t_ms": 0,
                    },
                ],
            },
        ],
    }
    doc = build_tape_from_recording(recording, user_prompt="p")
    assert doc["meta"]["followups"] == ["A", "B"]
    assert "followups_generated" not in [e["type"] for e in doc["events"]]
    # Caller override wins.
    doc2 = build_tape_from_recording(
        recording, meta={"followups": ["X"]}, user_prompt="p"
    )
    assert doc2["meta"]["followups"] == ["X"]


# ── tap 录制 → 回放闭环（合成回合） ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_recording_to_tape_to_replay_closed_loop(monkeypatch, tmp_path: Path):
    """合成回合闭环：真实 EventSink 发流 → tap 录制 → 出磁带 → player 回放。

    覆盖录制层重构的验收面：磁带无生命周期/结算事件、暂停点如期挂起、回放身份
    重铸（≠录制 id）、resume 后正文/辩手输出逐字节回放、live resolve 恰好一次、
    followups 经 meta 保真透传。
    """
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import continue_tape_turn, play_tape_events
    from agentcore.runtime.events import (
        followups_generated,
        message_end,
        message_start,
        team_preview_resolved,
    )
    from agentcore.runtime.journal.writer import TurnJournalWriter

    chips = ["下一步甲", "下一步乙"]
    recorder = _install_recorder_at(monkeypatch, tmp_path)
    try:
        # —— Source run (send leg): brief → kickoff card → paused. ——
        send_sink = EventSink(conversation_id="src-conv", message_id="src-msg")
        send_sink.emit(message_start("src-msg", conversation_id="src-conv"))
        send_sink.emit(_ev("reasoning_delta", {"delta": "先搜索案件。"}))
        send_sink.emit(
            _ev(
                "tool_use_start",
                {"tool_call_id": "t1", "tool_name": "web_search", "arguments": {}},
            )
        )
        send_sink.emit(_ev("tool_use_end", {"tool_call_id": "t1", "tool_name": "web_search"}))
        send_sink.emit(_ev("content_delta", {"delta": "案情简介。"}))
        send_sink.emit(_ev("tool_progress", {"tool_name": "debate", "chars": 42}))
        send_sink.emit(
            _ev(
                "team_preview_required",
                {
                    "checkpoint_id": "cp-src",
                    "form": "debate",
                    "primitive": "debate",
                    "motion": "m",
                    "sides": [{"key": "a", "name": "A", "stance": "s"}],
                    "workers": [],
                    "tools": [],
                    "max_rounds": 2,
                    "thorough": True,
                },
            )
        )
        send_sink.emit(message_end(FinishReason.PAUSED))

        # —— Source run (resume leg): live resolve → debate → wrap → end. ——
        resume_sink = EventSink(conversation_id="src-conv", message_id="src-msg")
        resume_sink.emit(
            team_preview_resolved(checkpoint_id="cp-src", decision="continue", note="")
        )
        resume_sink.emit(_ev("run_plan", {"execution_id": "ex1", "runs": []}))
        resume_sink.emit(_ev("run_started", {"run_id": "w1", "agent_id": "w1", "kind": "agent"}))
        resume_sink.emit(_ev("run_output_delta", {"run_id": "w1", "agent_id": "w1", "delta": "辩手观点。"}))
        resume_sink.emit(_ev("run_completed", {"run_id": "w1", "agent_id": "w1"}))
        resume_sink.emit(_ev("content_delta", {"delta": "最终汇总。"}))
        resume_sink.emit(message_end(FinishReason.END_TURN))
        # Post-turn chips (persist_turn_result order) — must still be on the recording.
        resume_sink.emit(
            followups_generated(chips, conversation_id="src-conv", message_id="src-msg")
        )

        recording = recorder.load_recording(recorder.recording_path("src-msg"))
    finally:
        recorder.uninstall_recorder()

    tape_doc = build_tape_from_recording(
        recording, meta={"title": "闭环"}, user_prompt="搜索并辩论"
    )
    assert tape_doc["version"] == TAPE_FORMAT_VERSION
    assert tape_doc["meta"]["followups"] == chips
    types = [e["type"] for e in tape_doc["events"]]
    assert "message_start" not in types
    assert "message_end" not in types
    assert "team_preview_resolved" not in types
    assert "followups_generated" not in types
    assert "tool_progress" in types  # EPHEMERAL liveliness recorded verbatim
    assert all("kind" not in e for e in tape_doc["events"])
    tape_path = tmp_path / "closed-loop.json"
    write_tape(tape_path, tape_doc)

    # —— Replay through the real player. ——
    saved: list = []

    async def fake_save(suspension):
        saved.append(suspension)

    monkeypatch.setattr(player_mod, "save_paused_turn", fake_save)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    binding = TapeBinding(
        conversation_id="replay-conv", tape_path=tape_path, speed=100.0, max_gap_ms=20
    )
    events = list(load_tape(tape_path)["events"])
    sink = EventSink(conversation_id="replay-conv", message_id="replay-msg")
    writer = TurnJournalWriter(
        turn_id="replay-msg", conversation_id="replay-conv", trace_id="c" * 32
    )
    result = await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="replay-msg",
        conversation_id="replay-conv",
        user_id="u",
        user_message="go",
        folder_id=None,
        journal_writer=writer,
    )
    assert result["finish_reason"] is FinishReason.PAUSED
    assert result["content"] == "案情简介。"
    card = next(e for e in sink._history if e.type is EventType.TEAM_PREVIEW_REQUIRED)
    assert card.payload["checkpoint_id"] != "cp-src"  # replay identity reminted

    sink2 = EventSink(conversation_id="replay-conv", message_id="replay-msg")
    result2 = await continue_tape_turn(
        suspension=saved[0],
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE, note=""),
        sink=sink2,
        folder_id=None,
        trace_id="c" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    assert result2["content"] == "案情简介。最终汇总。"
    assert result2["followups"] == chips
    # Player does not emit followups_generated — persist_turn_result does.
    assert EventType.FOLLOWUPS_GENERATED not in [e.type for e in sink2._history]
    types2 = [e.type for e in sink2._history]
    assert types2.count(EventType.TEAM_PREVIEW_RESOLVED) == 1
    deltas = [
        e.payload.get("delta")
        for e in sink2._history
        if e.type is EventType.RUN_OUTPUT_DELTA
    ]
    assert "".join(d for d in deltas if d) == "辩手观点。"


@pytest.mark.asyncio
async def test_tape_followups_persist_emits_and_skips_mint(monkeypatch, tmp_path: Path):
    """meta.followups → END_TURN result → persist set_followups + emit, no mint_followups."""
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from agentcore.conversation import turn_persistence
    from agentcore.conversation.store import cloud as cloud_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import play_tape_turn
    from agentcore.runtime.journal.writer import TurnJournalWriter

    chips = [
        "模拟庭审辩论的结论整理成一页摘要",
        "把公共领域抗辩的关键考古证据单独列出来",
        "起草一份茉莉奶白二审上诉的核心论点提纲",
    ]
    tape_path = tmp_path / "fu-tape.json"
    write_tape(
        tape_path,
        {
            "version": 2,
            "meta": {"followups": chips, "user_prompt": "go"},
            "events": [
                {
                    "type": "run_started",
                    "payload": {"run_id": "c1", "kind": "captain"},
                    "timestamp": None,
                    "t_ms": 0,
                },
                {
                    "type": "content_delta",
                    "payload": {"delta": "结案。"},
                    "timestamp": None,
                    "t_ms": 10,
                },
            ],
        },
    )

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    binding = TapeBinding(
        conversation_id="conv-fu", tape_path=tape_path, speed=100.0, max_gap_ms=0
    )
    sink = EventSink(conversation_id="conv-fu", message_id="msg-live")
    result = await play_tape_turn(
        binding=binding,
        sink=sink,
        message_id="msg-live",
        conversation_id="conv-fu",
        user_id="u",
        user_message="go",
        folder_id=None,
        trace_id="d" * 32,
    )
    assert result["finish_reason"] is FinishReason.END_TURN
    assert result["followups"] == chips
    assert EventType.FOLLOWUPS_GENERATED not in [e.type for e in sink._history]

    stored: list[tuple] = []
    mint = AsyncMock(return_value=["should-not-mint"])

    class FakeRepo:
        def __init__(self, _session):
            pass

        async def upsert_assistant(self, **kwargs):
            return SimpleNamespace(id=kwargs["message_id"])

        async def set_followups(self, message_id, *, conversation_id, followups):
            stored.append((message_id, conversation_id, list(followups)))

    class FakeSessionCM:
        async def __aenter__(self):
            return SimpleNamespace()

        async def __aexit__(self, *_a):
            return False

    class FakeMetrics:
        def __init__(self, _s):
            pass

        async def record(self, **_kw):
            return None

    monkeypatch.setattr(cloud_mod, "MessageRepository", FakeRepo)
    monkeypatch.setattr(cloud_mod, "TurnMetricsRepository", FakeMetrics)
    monkeypatch.setattr(cloud_mod, "async_session_factory", lambda: FakeSessionCM())
    monkeypatch.setattr(cloud_mod, "persist_turn_journal", AsyncMock())
    monkeypatch.setattr(cloud_mod, "schedule_consolidation", lambda _c: None)
    monkeypatch.setattr(cloud_mod, "schedule_compaction", lambda *_a: None)
    monkeypatch.setattr(cloud_mod, "mint_followups", mint)
    monkeypatch.setattr(
        cloud_mod.settings, "workspace_snapshot_enabled", False, raising=False
    )

    class FakeBackend:
        location = "server"
        dirty = False

    persist_sink = EventSink(conversation_id="conv-fu", message_id="msg-live")
    await turn_persistence.persist_turn_result(
        result=result,
        conversation_id="conv-fu",
        user_id="u",
        folder_id=None,
        backend=FakeBackend(),  # type: ignore[arg-type]
        sink=persist_sink,
        user_message="go",
        llm_credentials=None,
        trace_id="d" * 32,
        turn_id="msg-live",
        duration_ms=1,
    )

    mint.assert_not_awaited()
    assert stored == [("msg-live", "conv-fu", chips)]
    fu_events = [e for e in persist_sink._history if e.type is EventType.FOLLOWUPS_GENERATED]
    assert len(fu_events) == 1
    assert fu_events[0].payload["followups"] == chips
    assert fu_events[0].payload["message_id"] == "msg-live"


# ── player ───────────────────────────────────────────────────────────────


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
    # Shared resume bootstrap emits message_start (live parity).
    assert EventType.MESSAGE_START in types2
    assert EventType.TEAM_PREVIEW_RESOLVED in types2
    assert EventType.RUN_OUTPUT_DELTA in types2
    # Recorded resolve must not be double-emitted from tape
    assert types2.count(EventType.TEAM_PREVIEW_RESOLVED) == 1
    # Pause frame carries turn_paused (content on shared fact, not DEMO_TAPE_FRAME_KEY).
    paused_fact = next(
        (
            e
            for e in (saved[0].journal_entries or [])
            if e.get("kind") == "turn_paused"
        ),
        None,
    )
    assert paused_fact is not None
    assert "content" not in (saved[0].debate_arguments.get(DEMO_TAPE_FRAME_KEY) or {})
    # Reload path: journal_entries must carry message_final so fold can splice deltas.
    entries = result2.get("journal_entries") or []
    assert any(e.get("kind") == "message_final" for e in entries)


@pytest.mark.asyncio
async def test_resume_keeps_pre_pause_content_visible_across_collab_graph(
    monkeypatch, tmp_path: Path
):
    """授权恢复进入协作图后，fold 可见正文仍含挂起前 CEO 正文（跨挂起边界）。

    覆盖此前盲区：fidelity 只比 player→sink 字节，不查客户端 fold 可见性；
    live 用 G6 重灌挡住 content_reset，磁带旁路曾漏掉导致气泡被清空。
    """
    from agentcore.conformance.projection import project_turn
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import continue_tape_turn, play_tape_events
    from agentcore.runtime.events import content_reset
    from agentcore.runtime.facts import TurnFactLog, current_fact_log
    from agentcore.runtime.journal.writer import TurnJournalWriter

    saved: list = []

    async def fake_save(suspension):
        saved.append(suspension)

    monkeypatch.setattr(player_mod, "save_paused_turn", fake_save)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    pre_pause_body = "案情简介已讲清，启动模拟庭审。"
    events = [
        {"kind": "run_started", "payload": {"run_id": "c1", "kind": "captain"}, "t_ms": 0},
        {"kind": "content_delta", "payload": {"delta": pre_pause_body}, "t_ms": 50},
        {
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp-vis",
                "form": "debate",
                "sides": [{"key": "a", "name": "A"}],
                "workers": [],
                "tools": [],
                "primitive": "debate",
                "motion": "m",
                "max_rounds": 2,
                "thorough": True,
            },
            "t_ms": 100,
        },
        {"kind": "team_preview_resolved", "payload": {"decision": "continue"}, "t_ms": 150},
        {
            "kind": "run_plan",
            "payload": {
                "execution_id": "ex1",
                "plan_type": "debate",
                "runs": [{"run_id": "w1", "agent_id": "w1"}],
                "agents": [{"id": "w1", "role": "辩手"}],
            },
            "t_ms": 200,
        },
        {
            "kind": "run_started",
            "payload": {"run_id": "w1", "agent_id": "w1", "kind": "agent"},
            "t_ms": 250,
        },
        {
            "kind": "run_output_delta",
            "payload": {"run_id": "w1", "agent_id": "w1", "delta": "辩方观点。"},
            "t_ms": 300,
        },
        {"kind": "content_delta", "payload": {"delta": "庭审汇总。"}, "t_ms": 400},
    ]
    tape_path = tmp_path / "vis.json"
    tape_path.write_text(
        json.dumps({"version": 1, "meta": {}, "events": events}, ensure_ascii=False),
        encoding="utf-8",
    )
    binding = TapeBinding(
        conversation_id="conv-vis",
        tape_path=tape_path,
        speed=100.0,
        max_gap_ms=50,
    )
    sink = EventSink(conversation_id="conv-vis", message_id="msg-vis")
    writer = TurnJournalWriter(
        turn_id="msg-vis", conversation_id="conv-vis", trace_id="v" * 32
    )
    fact_token = current_fact_log.set(TurnFactLog())
    try:
        result = await play_tape_events(
            sink=sink,
            events=events,
            start_index=0,
            binding=binding,
            message_id="msg-vis",
            conversation_id="conv-vis",
            user_id="u",
            user_message="go",
            folder_id=None,
            journal_writer=writer,
        )
    finally:
        current_fact_log.reset(fact_token)

    assert result["finish_reason"] is FinishReason.PAUSED
    assert pre_pause_body in (result.get("content") or "")
    turn_paused = next(
        e for e in (saved[0].journal_entries or []) if e.get("kind") == "turn_paused"
    )
    assert pre_pause_body in str((turn_paused.get("payload") or {}).get("content") or "")

    sink2 = EventSink(conversation_id="conv-vis", message_id="msg-vis")
    result2 = await continue_tape_turn(
        suspension=saved[0],
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE, note=""),
        sink=sink2,
        folder_id=None,
        trace_id="v" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    assert pre_pause_body in (result2.get("content") or "")
    assert EventType.RUN_PLAN in [e.type for e in sink2._history]

    # Client-visible fold across pause→resume at collab-graph stage (before any reset).
    wire: list[dict] = []
    for e in sink._history:
        wire.append({"type": e.type.value, "payload": e.payload})
    for e in sink2._history:
        wire.append({"type": e.type.value, "payload": e.payload})
    projected = project_turn(wire)
    assert pre_pause_body in (projected.get("content") or "")

    # G6: content_reset after resume must reinject pre_pause (display-only).
    assert sink2._content_reset_reinjection == pre_pause_body + "\n\n"
    sink2.emit(content_reset("finish_guard"))
    reinjected = [
        e.payload.get("delta")
        for e in sink2._history
        if e.type is EventType.CONTENT_DELTA
    ]
    assert any(pre_pause_body in str(d) for d in reinjected if d)

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
    assert emitted[0] == replay_interaction_id("cp-recorded", message_id="msg-a")
    assert emitted[1] == replay_interaction_id("cp-recorded", message_id="msg-b")

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
    from agentcore.replay.legacy import captain_run_id_from_events

    assert (
        captain_run_id_from_events(
            [
                {"type": "message_start", "payload": {}},
                {"type": "run_started", "payload": {"run_id": "cap1", "kind": "captain"}},
                {"type": "run_started", "payload": {"run_id": "w1", "kind": "agent"}},
            ]
        )
        == "cap1"
    )
    # Legacy dialect still resolves.
    assert (
        captain_run_id_from_events(
            [{"kind": "run_started", "payload": {"run_id": "cap1", "kind": "captain"}}]
        )
        == "cap1"
    )
    # No captain run → empty (nothing to normalize).
    assert (
        captain_run_id_from_events(
            [{"type": "run_started", "payload": {"run_id": "w1"}}]
        )
        == ""
    )


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


@pytest.mark.asyncio
async def test_resume_folds_team_preview_into_resolved(monkeypatch, tmp_path: Path):
    """磁带回放开工卡授权后，client fold（reload + live 两路）必须把 team_preview 判为
    resolved（并入协作图），而不是停在 pending「等待开工确认」横条。

    回归钉子：曾出现「协作图已长满、顶部仍残留待确认横条」的旁路 bug（team_preview 停
    在 pending）。修复靠 ① continue_tape_turn 结算时 emit team_preview_resolved，②
    identity.remint 让 send/resume 两腿共用同一 checkpoint_id。此测试锁死两点，且覆盖
    reload（journal_entries → runs_from_entries）与 live（send._history + resume._history）
    两条 fold 路径，防 demo_tape 重构再退化。桌面 fold 逻辑同源见
    stores/interactions（hydrateInteractionsFromJournal）。
    """
    from agentcore.conformance.projection import project_turn
    from agentcore.demo_tape import player as player_mod
    from agentcore.demo_tape.binding import TapeBinding
    from agentcore.demo_tape.player import continue_tape_turn, play_tape_events
    from agentcore.runtime.journal.fold import runs_from_entries
    from agentcore.runtime.journal.writer import TurnJournalWriter

    saved: list = []

    async def fake_save(suspension):
        saved.append(suspension)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(player_mod, "save_paused_turn", fake_save)
    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    events = [
        {"kind": "run_started", "payload": {"run_id": "c1", "kind": "captain"}, "t_ms": 0},
        {
            "kind": "team_preview_required",
            "payload": {
                "checkpoint_id": "cp-tape",
                "form": "debate",
                "sides": [{"key": "lv", "name": "LV"}, {"key": "ml", "name": "ML"}],
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
            "kind": "run_plan",
            "payload": {
                "execution_id": "ex1",
                "plan_type": "debate",
                "runs": [{"run_id": "w1", "agent_id": "w1"}],
                "agents": [{"id": "w1", "role": "辩手"}],
            },
            "t_ms": 250,
        },
        {
            "kind": "run_started",
            "payload": {"run_id": "w1", "agent_id": "w1", "kind": "agent"},
            "t_ms": 260,
        },
        {
            "kind": "run_output_delta",
            "payload": {"run_id": "w1", "agent_id": "w1", "delta": "观点"},
            "t_ms": 300,
        },
        {"kind": "content_delta", "payload": {"delta": "汇总"}, "t_ms": 400},
    ]
    tape_path = tmp_path / "tp_resolve.json"
    tape_path.write_text(
        json.dumps({"version": 1, "meta": {}, "events": events}, ensure_ascii=False),
        encoding="utf-8",
    )
    binding = TapeBinding(
        conversation_id="conv1", tape_path=tape_path, speed=100.0, max_gap_ms=50
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
    required_ids = {
        e.payload["checkpoint_id"]
        for e in sink._history
        if e.type is EventType.TEAM_PREVIEW_REQUIRED
    }
    assert len(required_ids) == 1
    assert "cp-tape" not in required_ids  # reminted, never the recorded id

    sink2 = EventSink(conversation_id="conv1", message_id="msg1")
    result2 = await continue_tape_turn(
        suspension=saved[0],
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE, note=""),
        sink=sink2,
        folder_id=None,
        trace_id="t" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    resolved_ids = {
        e.payload.get("checkpoint_id")
        for e in sink2._history
        if e.type is EventType.TEAM_PREVIEW_RESOLVED
    }
    # send/resume legs settle the SAME reminted checkpoint (else the pending card lingers).
    assert resolved_ids == required_ids

    def _team_preview(proj: dict) -> dict:
        cards = [i for i in proj.get("interactions", []) if i.get("kind") == "team_preview"]
        assert len(cards) == 1, f"expected 1 team_preview, got {cards}"
        return cards[0]

    # Reload fold: message-detail projects turn_journal via runs_from_entries.
    runs = runs_from_entries(list(result2.get("journal_entries") or []))
    reload_wire = [
        {"type": ev["type"], "payload": ev.get("payload") or {}}
        for ev in (runs or {}).get("events", [])
    ]
    assert _team_preview(project_turn(reload_wire))["status"] == "resolved"

    # Live fold: desktop folds send leg + resume leg SSE histories back-to-back.
    live_wire = [
        {"type": e.type.value, "payload": e.payload}
        for e in (*sink._history, *sink2._history)
    ]
    assert _team_preview(project_turn(live_wire))["status"] == "resolved"


# ── 入库脱敏双防线 + 导出门禁 + 客户端工具断言 ─────────────────────────────


_REAL_MEMORY_RULES = """<rules>
以下是关于当前用户的长期记忆（由 AI 自动维护，属软性偏好）。请在不与用户当前
指令冲突的前提下遵循；如有冲突，以用户的显式指令为准。

## 沟通偏好
- 倾向用中文交流 <!-- ts:2026-07-13 -->

## 关于用户的事实
- 正在测试秘密功能 <!-- ts:2026-07-16 -->
</rules>"""


def test_sanitize_memory_keeps_rules_block_structure():
    prompt = f"前置\n{_REAL_MEMORY_RULES}\n<role>\n你是 CEO\n</role>"
    out = sanitize_memory_in_text(prompt)
    assert DEMO_MEMORY_PLACEHOLDER in out
    assert "<!-- ts:" not in out
    assert "正在测试秘密功能" not in out
    assert out.startswith("前置\n")
    assert "<role>\n你是 CEO\n</role>" in out
    assert SYNTHETIC_MEMORY_RULES in out


def test_sanitize_and_scan_run_context_clears_memory():
    events = [
        {
            "type": "run_context",
            "payload": {
                "run_id": "r1",
                "blocks": [
                    {"channel": "system", "body": f"head\n{_REAL_MEMORY_RULES}\ntail"},
                    {"channel": "request", "body": "用户问题"},
                ],
            },
            "timestamp": None,
            "t_ms": 0,
        }
    ]
    cleaned = sanitize_and_scan_events(events)
    body = cleaned[0]["payload"]["blocks"][0]["body"]
    assert DEMO_MEMORY_PLACEHOLDER in body
    assert "秘密功能" not in body
    assert cleaned[0]["payload"]["blocks"][1]["body"] == "用户问题"
    assert_ingest_clean(cleaned)


def test_ingest_scan_rejects_unsanitized_memory_and_system_contacts():
    dirty = [
        {
            "type": "run_context",
            "payload": {
                "blocks": [
                    {
                        "channel": "system",
                        "body": (
                            "x\n## 沟通偏好\n- 真偏好 <!-- ts:2026-01-01 -->\n"
                            "mail me@example.com phone 13812345678"
                        ),
                    }
                ]
            },
        }
    ]
    hits = scan_events_for_ingest_residue(dirty)
    assert any("timestamp marker" in h or "沟通偏好" in h for h in hits)
    with pytest.raises(IngestScanError):
        assert_ingest_clean(dirty)

    # Public contacts in tool results must NOT trip the gate (demo web search noise).
    toolish = [
        {
            "type": "tool_use_end",
            "payload": {
                "result": "见 https://www.sohu.com/a/1050304127_121811866 ipc@court.gov.cn"
            },
        }
    ]
    assert scan_events_for_ingest_residue(toolish) == []


def test_export_refuses_unwired_pause_and_approval_unless_forced():
    assert "checkpoint_required" in TAPE_UNWIRED_PAUSE_KINDS
    recording = {
        "meta": {"conversation_id": "c", "message_id": "m"},
        "segments": [
            {
                "events": [
                    {
                        "type": "content_delta",
                        "payload": {"delta": "hi"},
                        "timestamp": None,
                        "t_ms": 0,
                    },
                    {
                        "type": "checkpoint_required",
                        "payload": {"checkpoint_id": "cp1"},
                        "timestamp": None,
                        "t_ms": 10,
                    },
                ]
            }
        ],
    }
    with pytest.raises(TapeExportRefusedError) as ei:
        build_tape_from_recording(recording, user_prompt="p")
    assert any("checkpoint_required" in r for r in ei.value.reasons)

    doc = build_tape_from_recording(recording, user_prompt="p", force=True)
    assert [e["type"] for e in doc["events"]] == ["content_delta", "checkpoint_required"]

    approval_rec = {
        "meta": {},
        "segments": [
            {
                "events": [
                    {
                        "type": "approval_required",
                        "payload": {"approval_id": "a1"},
                        "timestamp": None,
                        "t_ms": 0,
                    }
                ]
            }
        ],
    }
    with pytest.raises(TapeExportRefusedError):
        build_tape_from_recording(approval_rec, user_prompt="p")
    build_tape_from_recording(approval_rec, user_prompt="p", force=True)


def test_export_asserts_client_tool_required_not_forceable():
    # Defense beyond the cut table: if a client-tool event slips into the cut
    # result, export must refuse even with force=True.
    leaked = [
        {
            "type": "workspace_op_required",
            "payload": {"op_id": "op1"},
            "timestamp": None,
            "t_ms": 0,
        }
    ]
    with pytest.raises(TapeExportRefusedError) as ei:
        assert_export_allowed(leaked, force=True)
    assert any("client-tool" in r for r in ei.value.reasons)
    assert CLIENT_TOOL_REQUIRED_KINDS <= TAPE_EXCLUDED_KINDS


def test_build_tape_sanitizes_run_context_memory():
    recording = {
        "meta": {"conversation_id": "c", "message_id": "m"},
        "segments": [
            {
                "events": [
                    {
                        "type": "run_context",
                        "payload": {
                            "run_id": "r1",
                            "blocks": [
                                {"channel": "system", "body": _REAL_MEMORY_RULES},
                            ],
                        },
                        "timestamp": None,
                        "t_ms": 0,
                    },
                    {
                        "type": "content_delta",
                        "payload": {"delta": "ok"},
                        "timestamp": None,
                        "t_ms": 5,
                    },
                ]
            }
        ],
    }
    doc = build_tape_from_recording(recording, user_prompt="p")
    body = doc["events"][0]["payload"]["blocks"][0]["body"]
    assert DEMO_MEMORY_PLACEHOLDER in body
    assert "<!-- ts:" not in body
    assert_ingest_clean(doc["events"])
