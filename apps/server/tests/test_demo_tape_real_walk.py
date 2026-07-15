"""In-process walk of the exported LV/茉莉奶白 tape (pause → resume → end).

This is the acceptance HTTP-walk substitute when a live server isn't flagged:
same player path the SSE route uses, with pacing assertions. For a true HTTP
client walk against a running server see ``scripts/demo_tape_http_walk.py``.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agentcore.config.paths import PROJECT_ROOT
from agentcore.demo_tape.binding import TapeBinding
from agentcore.demo_tape.pacing import sleep_ms_for_gap
from agentcore.demo_tape.player import continue_tape_turn, play_tape_events
from agentcore.demo_tape.schema import DEMO_TAPE_FRAME_KEY
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import EventSink, EventType, FinishReason
from agentcore.runtime.journal.writer import TurnJournalWriter

TAPE = PROJECT_ROOT / "demos" / "tapes" / "lv-molihua-trademark.json"


@pytest.mark.asyncio
async def test_real_tape_pause_resume_and_pacing(monkeypatch):
    if not TAPE.exists():
        pytest.skip(f"tape not exported yet: {TAPE}")

    from agentcore.demo_tape import player as player_mod

    saved: list = []

    async def fake_save(suspension):
        saved.append(suspension)

    async def noop_flush(self):
        return None

    monkeypatch.setattr(player_mod, "save_paused_turn", fake_save)
    monkeypatch.setattr(TurnJournalWriter, "flush", noop_flush)

    data = json.loads(TAPE.read_text(encoding="utf-8"))
    events = list(data["events"])
    assert any(e["kind"] == "team_preview_required" for e in events)
    assert any(e["kind"] == "debate_round_started" for e in events)
    assert any(e["kind"] == "debate_result" for e in events)

    # Pacing math: every original gap must compress under speed/cap.
    speed, max_gap = 8.0, 500
    prev = None
    for ev in events[:200]:
        t = int(ev["t_ms"])
        if prev is not None:
            delay = sleep_ms_for_gap(gap_ms=t - prev, speed=speed, max_gap_ms=max_gap)
            assert delay <= (max_gap / speed) / 1000.0 + 1e-9
        prev = t

    binding = TapeBinding(
        conversation_id="walk-conv",
        tape_path=TAPE,
        speed=100.0,
        max_gap_ms=20,
    )
    sink = EventSink(conversation_id="walk-conv", message_id="walk-msg")
    writer = TurnJournalWriter(
        turn_id="walk-msg", conversation_id="walk-conv", trace_id="a" * 32
    )

    result = await play_tape_events(
        sink=sink,
        events=events,
        start_index=0,
        binding=binding,
        message_id="walk-msg",
        conversation_id="walk-conv",
        user_id="walk-user",
        user_message="demo",
        folder_id=None,
        journal_writer=writer,
        trace_id="a" * 32,
    )
    assert result["finish_reason"] is FinishReason.PAUSED
    assert saved and DEMO_TAPE_FRAME_KEY in saved[0].debate_arguments
    assert EventType.TEAM_PREVIEW_REQUIRED in [e.type for e in sink._history]

    # Continue: only play a short tail after the pause for runtime (full tape is long).
    meta = saved[0].debate_arguments[DEMO_TAPE_FRAME_KEY]
    next_index = int(meta["next_index"])
    # Truncate post-pause events for the test, keep structure checks.
    tail = events[next_index : next_index + 40]
    # Re-stamp tape file cursor by rewriting suspension meta to a truncated tape.
    mini = TAPE.parent / "_walk_tail.json"
    mini.write_text(
        json.dumps(
            {"version": 1, "meta": {}, "events": events[:next_index] + tail},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    saved[0].debate_arguments[DEMO_TAPE_FRAME_KEY]["tape"] = str(mini)
    # next_index still points into the combined list (prefix + tail) at len(prefix)
    saved[0].debate_arguments[DEMO_TAPE_FRAME_KEY]["next_index"] = next_index

    sink2 = EventSink(conversation_id="walk-conv", message_id="walk-msg")
    result2 = await continue_tape_turn(
        suspension=saved[0],
        response=CheckpointResponse(decision=CheckpointDecision.CONTINUE),
        sink=sink2,
        folder_id=None,
        trace_id="a" * 32,
    )
    assert result2["finish_reason"] is FinishReason.END_TURN
    types2 = [e.type for e in sink2._history]
    assert EventType.TEAM_PREVIEW_RESOLVED in types2
    # Recorded resolves were skipped; only the live one.
    assert types2.count(EventType.TEAM_PREVIEW_RESOLVED) == 1
