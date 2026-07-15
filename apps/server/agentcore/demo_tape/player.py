"""Play a demo tape through a live EventSink (dev-only)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.demo_tape.binding import TapeBinding
from agentcore.demo_tape.export import load_tape
from agentcore.demo_tape.pacing import pacing_step, sleep_ms_for_gap
from agentcore.demo_tape.schema import (
    DEMO_TAPE_FRAME_KEY,
    PAUSE_REQUIRED_KINDS,
    PAUSE_RESOLVED_KINDS,
    is_demo_tape_frame,
)
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    EventType,
    FinishReason,
    message_end,
    message_start,
    team_preview_resolved,
)
from agentcore.runtime.events.types import SSEEvent
from agentcore.runtime.journal.entries import journal_entries_from_display_runs
from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.pipeline.finalize import _build_runs_payload
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.suspension import TeamPreviewSuspension
from agentcore.runtime.suspension_persistence import save_paused_turn

logger = get_logger(__name__)


def _event_type(kind: str) -> EventType | None:
    try:
        return EventType(kind)
    except ValueError:
        return None


def _iso_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def _emit(sink: EventSink, kind: str, payload: dict[str, Any], *, ts: str | None) -> None:
    et = _event_type(kind)
    if et is None:
        logger.debug("demo_tape.skip_unknown_kind", kind=kind)
        return
    sink.emit(SSEEvent(type=et, payload=payload, timestamp=ts or _iso_now()))


def _accumulate_text(buf: list[str], kind: str, payload: dict[str, Any]) -> None:
    if kind in ("content_delta", "reasoning_delta"):
        delta = payload.get("delta") or ""
        if delta:
            buf.append(str(delta))


def _message_finals_from_sink(sink: EventSink) -> list[dict[str, Any]]:
    """Build ``message_final`` facts from coalesced per-run process text.

    Reload splices ``run_output_delta`` from these (deltas are DERIVED / not journaled).
    Joining every content/reasoning step is correct even if mid-play fragmentation
    left multiple steps per run.
    """
    processes = sink.run_process_timelines() or {}
    finals: list[dict[str, Any]] = []
    for run_id, steps in processes.items():
        content = "".join(
            str(s.get("text") or "") for s in (steps or []) if s.get("kind") == "content"
        )
        reasoning = "".join(
            str(s.get("text") or "") for s in (steps or []) if s.get("kind") == "reasoning"
        )
        if not content and not reasoning:
            continue
        finals.append(
            {
                "kind": "message_final",
                "payload": {
                    "run_id": run_id,
                    "content": content,
                    "reasoning": reasoning,
                },
                "ts": None,
            }
        )
    return finals


def _result_from_sink(
    *,
    sink: EventSink,
    message_id: str,
    finish: FinishReason,
    content: str,
    reasoning: str,
) -> dict[str, Any]:
    runs = _build_runs_payload(sink, finish)
    journal_entries = journal_entries_from_display_runs(runs) if runs else None
    # Finalize persist replaces the turn journal with this list — include message_final
    # so runs_from_entries can splice worker output on reload (oracle parity).
    if journal_entries is not None:
        finals = _message_finals_from_sink(sink)
        if finals:
            body = [e for e in journal_entries if e.get("kind") != "turn_end"]
            tail = [e for e in journal_entries if e.get("kind") == "turn_end"]
            journal_entries = body + finals + tail
    return {
        "message_id": message_id,
        "content": content,
        "reasoning_content": reasoning or None,
        "input_tokens": 0,
        "output_tokens": 0,
        "reasoning_tokens": 0,
        "cache_hit_tokens": 0,
        "cache_miss_tokens": 0,
        "rounds": 0,
        "finish_reason": finish,
        "citations": None,
        "cost_runs": [],  # skip cost ledger for demo replay
        "journal_entries": journal_entries,
        "collab": {},
        "audit_drops": 0,
    }


async def _pause_team_preview(
    *,
    sink: EventSink,
    binding: TapeBinding,
    message_id: str,
    conversation_id: str,
    user_id: str,
    user_message: str,
    folder_id: str | None,
    payload: dict[str, Any],
    next_index: int,
    content: str,
    reasoning: str,
    journal_writer: TurnJournalWriter,
) -> dict[str, Any]:
    checkpoint_id = str(payload.get("checkpoint_id") or new_id())
    # Ensure the emitted card + frame share the same id (tape may already carry one).
    payload = {**payload, "checkpoint_id": checkpoint_id, "conversation_id": conversation_id}

    await journal_writer.flush()
    journal_entries = [
        {"kind": e["type"], "payload": e["payload"], "ts": e.get("timestamp")}
        for e in (sink.execution_journal() or [])
    ]

    suspension = TeamPreviewSuspension(
        message_id=message_id,
        conversation_id=conversation_id,
        user_id=user_id,
        captain_run_id=message_id,
        checkpoint_id=checkpoint_id,
        tool_call_id=f"tape_debate_{checkpoint_id[:8]}",
        base_system_prompt="__demo_tape__",
        user_message=user_message,
        folder_id=folder_id,
        memory_enabled=False,
        transcript=[],
        history=[],
        plan=RunPlan(),
        completed={},
        journal_entries=journal_entries,
        workers=list(payload.get("workers") or []),
        tools=list(payload.get("tools") or []),
        primitive=str(payload.get("primitive") or "debate"),
        motion=str(payload.get("motion") or ""),
        form=str(payload.get("form") or ""),
        sides=list(payload.get("sides") or []),
        max_rounds=int(payload.get("max_rounds") or 0),
        thorough=bool(payload.get("thorough", True)),
        debate_arguments={
            DEMO_TAPE_FRAME_KEY: {
                "tape": str(binding.tape_path),
                "next_index": next_index,
                "speed": binding.speed,
                "max_gap_ms": binding.max_gap_ms,
                "content": content,
                "reasoning": reasoning,
            },
            "motion": payload.get("motion") or "",
            "form": payload.get("form") or "",
            "sides": list(payload.get("sides") or []),
            "thorough": bool(payload.get("thorough", True)),
        },
    )
    await save_paused_turn(suspension)
    sink.emit(message_end(FinishReason.PAUSED))
    logger.info(
        "demo_tape.paused",
        message_id=message_id,
        checkpoint_id=checkpoint_id,
        next_index=next_index,
    )
    return _result_from_sink(
        sink=sink,
        message_id=message_id,
        finish=FinishReason.PAUSED,
        content=content,
        reasoning=reasoning,
    )


async def play_tape_events(
    *,
    sink: EventSink,
    events: list[dict[str, Any]],
    start_index: int,
    binding: TapeBinding,
    message_id: str,
    conversation_id: str,
    user_id: str,
    user_message: str,
    folder_id: str | None,
    journal_writer: TurnJournalWriter,
    content_seed: str = "",
    reasoning_seed: str = "",
    emit_message_start: bool = True,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """Play events from ``start_index``; pause on the next required card."""
    content_parts: list[str] = [content_seed] if content_seed else []
    reasoning_parts: list[str] = [reasoning_seed] if reasoning_seed else []

    if emit_message_start:
        sink.emit(
            message_start(
                message_id,
                conversation_id=conversation_id,
                trace_id=trace_id,
            )
        )

    prev_t = None
    i = start_index
    while i < len(events):
        ev = events[i]
        kind = str(ev.get("kind") or "")
        payload = dict(ev.get("payload") or {})
        t_ms = int(ev.get("t_ms") or 0)
        ts = ev.get("ts") if isinstance(ev.get("ts"), str) else None

        if kind in PAUSE_RESOLVED_KINDS:
            i += 1
            continue

        gap, prev_t = pacing_step(prev_t_ms=prev_t, t_ms=t_ms)
        delay = sleep_ms_for_gap(
            gap_ms=gap, speed=binding.speed, max_gap_ms=binding.max_gap_ms
        )
        if delay > 0:
            await asyncio.sleep(delay)

        if kind == "team_preview_required":
            # Emit the required card, then durable-pause.
            if "checkpoint_id" not in payload or not payload.get("checkpoint_id"):
                payload["checkpoint_id"] = new_id()
            payload["conversation_id"] = conversation_id
            await _emit(sink, kind, payload, ts=ts)
            content = "".join(content_parts)
            reasoning = "".join(reasoning_parts)
            return await _pause_team_preview(
                sink=sink,
                binding=binding,
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                user_message=user_message,
                folder_id=folder_id,
                payload=payload,
                next_index=i + 1,
                content=content,
                reasoning=reasoning,
                journal_writer=journal_writer,
            )

        if kind in PAUSE_REQUIRED_KINDS:
            # Other durable pause cards (plan_review / ask_user) are not yet wired for
            # tape frames — emit for visibility then continue (dev tape should avoid them).
            logger.warning("demo_tape.unhandled_pause_kind", kind=kind)
            await _emit(sink, kind, payload, ts=ts)
            i += 1
            continue

        await _emit(sink, kind, payload, ts=ts)
        if kind == "content_delta":
            _accumulate_text(content_parts, kind, payload)
        elif kind == "reasoning_delta":
            _accumulate_text(reasoning_parts, kind, payload)
        i += 1

    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    sink.emit(message_end(FinishReason.END_TURN))
    logger.info(
        "demo_tape.complete",
        message_id=message_id,
        events_played=i - start_index,
        content_chars=len(content),
    )
    return _result_from_sink(
        sink=sink,
        message_id=message_id,
        finish=FinishReason.END_TURN,
        content=content,
        reasoning=reasoning,
    )


async def play_tape_turn(
    *,
    binding: TapeBinding,
    sink: EventSink,
    message_id: str,
    conversation_id: str,
    user_id: str,
    user_message: str,
    folder_id: str | None,
    trace_id: str | None,
) -> dict[str, Any]:
    tape = load_tape(binding.tape_path)
    events = list(tape.get("events") or [])
    writer = TurnJournalWriter(
        turn_id=message_id,
        conversation_id=conversation_id,
        trace_id=trace_id,
    )
    token = current_journal_writer.set(writer)
    try:
        result = await play_tape_events(
            sink=sink,
            events=events,
            start_index=0,
            binding=binding,
            message_id=message_id,
            conversation_id=conversation_id,
            user_id=user_id,
            user_message=user_message,
            folder_id=folder_id,
            journal_writer=writer,
            trace_id=trace_id,
        )
        await writer.flush()
        return result
    finally:
        current_journal_writer.reset(token)


async def continue_tape_turn(
    *,
    suspension: TeamPreviewSuspension,
    response: CheckpointResponse,
    sink: EventSink,
    folder_id: str | None,
    trace_id: str | None,
) -> dict[str, Any]:
    """Resume a tape paused at team_preview after a real frontend resolve."""
    if not is_demo_tape_frame(suspension):
        raise RuntimeError("continue_tape_turn called on non-tape suspension")

    meta = dict(suspension.debate_arguments.get(DEMO_TAPE_FRAME_KEY) or {})
    tape_path = Path(str(meta["tape"]))
    next_index = int(meta.get("next_index") or 0)
    speed = float(meta.get("speed") or 1.0)
    max_gap_ms = int(meta.get("max_gap_ms") or 3000)
    content_seed = str(meta.get("content") or "")
    reasoning_seed = str(meta.get("reasoning") or "")

    binding = TapeBinding(
        conversation_id=suspension.conversation_id,
        tape_path=tape_path,
        speed=speed,
        max_gap_ms=max_gap_ms,
    )
    tape = load_tape(tape_path)
    events = list(tape.get("events") or [])

    # Seed sink journal so finalize can rebuild a full display stream.
    prior = [
        {
            "type": e.get("kind") or "",
            "payload": e.get("payload") or {},
            "timestamp": e.get("ts"),
        }
        for e in (suspension.journal_entries or [])
    ]
    if prior:
        sink.seed_journal(prior)

    # Emit live resolve (mirrors resume pipeline settlement).
    decision = response.decision
    if decision is CheckpointDecision.STOP:
        sink.emit(
            team_preview_resolved(
                checkpoint_id=suspension.checkpoint_id,
                decision=decision.value,
                note=response.note or "",
            )
        )
        sink.emit(message_end(FinishReason.CANCELLED))
        return _result_from_sink(
            sink=sink,
            message_id=suspension.message_id,
            finish=FinishReason.CANCELLED,
            content=content_seed,
            reasoning=reasoning_seed,
        )

    sink.emit(
        team_preview_resolved(
            checkpoint_id=suspension.checkpoint_id,
            decision=CheckpointDecision.CONTINUE.value,
            note=response.note or "",
        )
    )

    # Writer continues after sealed pause — new writer with seq after prior facts.
    initial_seq = len(suspension.journal_entries or [])
    writer = TurnJournalWriter(
        turn_id=suspension.message_id,
        conversation_id=suspension.conversation_id,
        trace_id=trace_id,
        initial_seq=initial_seq,
    )
    token = current_journal_writer.set(writer)
    try:
        result = await play_tape_events(
            sink=sink,
            events=events,
            start_index=next_index,
            binding=binding,
            message_id=suspension.message_id,
            conversation_id=suspension.conversation_id,
            user_id=suspension.user_id,
            user_message=suspension.user_message,
            folder_id=folder_id if folder_id is not None else suspension.folder_id,
            journal_writer=writer,
            content_seed=content_seed,
            reasoning_seed=reasoning_seed,
            emit_message_start=False,
            trace_id=trace_id,
        )
        await writer.flush()
        return result
    finally:
        current_journal_writer.reset(token)
