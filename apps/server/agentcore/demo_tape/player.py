"""Play a demo tape through a live EventSink (dev-only)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import new_id
from agentcore.demo_tape.binding import TapeBinding
from agentcore.demo_tape.export import load_tape
from agentcore.demo_tape.identity import replay_interaction_id
from agentcore.demo_tape.pacing import pacing_step, sleep_ms_for_gap
from agentcore.demo_tape.schema import (
    DEMO_TAPE_FRAME_KEY,
    PAUSE_REQUIRED_KINDS,
    PAUSE_RESOLVED_KINDS,
    event_timestamp,
    event_type,
    is_demo_tape_frame,
    tape_frame_meta,
)
from agentcore.demo_tape.transport import PlaybackTransport, transport_registry
from agentcore.llm.provider.protocol import LLMMessage
from agentcore.replay import (
    ConsumerKind,
    assert_sink_consumer,
    prepare_replay_source,
)
from agentcore.runtime.checkpoints import CheckpointDecision, CheckpointResponse
from agentcore.runtime.events import (
    EventSink,
    EventType,
    FinishReason,
    message_end,
    message_start,
    team_preview_required,
    team_preview_resolved,
)
from agentcore.runtime.events.types import SSEEvent
from agentcore.runtime.facts import TurnFactLog, current_fact_log, pre_pause_from_journal
from agentcore.runtime.journal.entries import journal_entries_from_display_runs
from agentcore.runtime.journal.writer import TurnJournalWriter, current_journal_writer
from agentcore.runtime.pipeline.finalize import _build_runs_payload
from agentcore.runtime.pipeline.resume.rehydrate import (
    arm_content_reset_reinjection,
    bootstrap_resume_display,
)
from agentcore.runtime.runs.plan import RunPlan
from agentcore.runtime.suspension import TeamPreviewSuspension, captain_transcript
from agentcore.runtime.suspension_capture import SuspensionPersistError, persist_suspension_capture
from agentcore.runtime.suspension_persistence import save_paused_turn

logger = get_logger(__name__)


def _as_event_type(name: str) -> EventType | None:
    try:
        return EventType(name)
    except ValueError:
        return None


def _iso_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


async def _emit(
    sink: EventSink, et_name: str, payload: dict[str, Any], *, ts: str | None
) -> None:
    et = _as_event_type(et_name)
    if et is None:
        logger.debug("demo_tape.skip_unknown_type", type=et_name)
        return
    sink.emit(SSEEvent(type=et, payload=payload, timestamp=ts or _iso_now()))


def _accumulate_text(buf: list[str], et_name: str, payload: dict[str, Any]) -> None:
    if et_name in ("content_delta", "reasoning_delta"):
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
    if runs:
        # Close open trailing captain text (e.g. the CEO summary content after the
        # collaboration graph) into the durable journal via append-on-emit — mirrors
        # pipeline.finalize._journal_entries_for_turn so a pure hydrate reload replays
        # it rather than only the live sink seeing it (process_content 落库).
        sink.flush_process_to_journal()
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


def _attach_tape_followups(result: dict[str, Any], tape: dict[str, Any]) -> dict[str, Any]:
    """On END_TURN, surface ``meta.followups`` on the pipeline result (persist emits).

    Player itself never emits ``followups_generated`` — cloud ``persist_turn_result``
    uses this list to set_followups + emit with the *current* turn message_id.
    Paused / cancelled results are left unchanged.
    """
    if result.get("finish_reason") is not FinishReason.END_TURN:
        return result
    raw = (tape.get("meta") or {}).get("followups")
    if not isinstance(raw, list) or not raw:
        return result
    followups = [str(x) for x in raw if str(x).strip()]
    if not followups:
        return result
    result["followups"] = followups
    return result


async def _emit_auto_resolved_team_preview(
    *,
    sink: EventSink,
    conversation_id: str,
    message_id: str,
    payload: dict[str, Any],
    ts: str | None,
) -> None:
    """Emit required + resolved without durable pause (director seek past the card)."""
    checkpoint_id = str(
        payload.get("checkpoint_id")
        or replay_interaction_id("", message_id=message_id)
    )
    required = team_preview_required(
        checkpoint_id=checkpoint_id,
        conversation_id=conversation_id,
        workers=list(payload.get("workers") or []),
        tools=list(payload.get("tools") or []),
        primitive=str(payload.get("primitive") or "debate"),
        motion=str(payload.get("motion") or ""),
        form=str(payload.get("form") or ""),
        sides=list(payload.get("sides") or []),
        max_rounds=int(payload.get("max_rounds") or 0),
        thorough=bool(payload.get("thorough", True)),
    )
    if ts:
        required = SSEEvent(
            type=required.type, payload=required.payload, timestamp=ts
        )
    sink.emit(required)
    sink.emit(
        team_preview_resolved(
            checkpoint_id=checkpoint_id,
            decision=CheckpointDecision.CONTINUE.value,
            note="demo_tape.director_auto_resolve",
        )
    )
    logger.info(
        "demo_tape.auto_resolved_team_preview",
        conversation_id=conversation_id,
        checkpoint_id=checkpoint_id,
    )


async def _pause_team_preview(
    *,
    sink: EventSink,
    binding: TapeBinding,
    message_id: str,
    conversation_id: str,
    user_id: str,
    user_message: str,
    folder_id: str | None,
    required: SSEEvent,
    next_index: int,
    journal_writer: TurnJournalWriter,
    transport: PlaybackTransport | None = None,
) -> dict[str, Any]:
    """Durable pause via the live suspension-capture skeleton (no tape content channel)."""
    checkpoint_id = str(required.payload.get("checkpoint_id") or new_id())
    payload = dict(required.payload)
    payload["checkpoint_id"] = checkpoint_id
    payload["conversation_id"] = conversation_id
    required = SSEEvent(
        type=required.type,
        payload=payload,
        timestamp=required.timestamp,
    )

    speed = transport.speed if transport is not None else binding.speed
    tape_meta = {
        "tape": str(binding.tape_path),
        "next_index": next_index,
        "speed": speed,
        "max_gap_ms": binding.max_gap_ms,
    }
    paused_content = ""
    paused_reasoning = ""

    def build_frame(capture):  # type: ignore[no-untyped-def]
        nonlocal paused_content, paused_reasoning
        paused_content = capture.paused_content
        fact = pre_pause_from_journal(capture.journal_entries)
        paused_reasoning = fact.reasoning if fact is not None else ""
        return TeamPreviewSuspension(
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
            transcript=list(capture.transcript),
            history=list(capture.history),
            plan=RunPlan(),
            completed={},
            journal_entries=capture.journal_entries,
            workers=list(payload.get("workers") or []),
            tools=list(payload.get("tools") or []),
            primitive=str(payload.get("primitive") or "debate"),
            motion=str(payload.get("motion") or ""),
            form=str(payload.get("form") or ""),
            sides=list(payload.get("sides") or []),
            max_rounds=int(payload.get("max_rounds") or 0),
            thorough=bool(payload.get("thorough", True)),
            # Divert marker only — content/reasoning live on turn_paused; cursor also
            # rides turn_paused.extras (same meta) via turn_paused_extras below.
            debate_arguments={
                DEMO_TAPE_FRAME_KEY: dict(tape_meta),
                "motion": payload.get("motion") or "",
                "form": payload.get("form") or "",
                "sides": list(payload.get("sides") or []),
                "thorough": bool(payload.get("thorough", True)),
            },
            citations=capture.citations,
            trace_id=capture.trace_id,
        )

    await journal_writer.flush()
    # Live capture requires a non-empty captain transcript; tape has no CEO loop —
    # seed a minimal window so the shared skeleton proceeds (content comes from sink).
    tr_token = captain_transcript.set([LLMMessage(role="user", content=user_message)])
    try:
        saved = await persist_suspension_capture(
            checkpoint_id=checkpoint_id,
            required_event=required,
            build_frame=build_frame,
            saver=save_paused_turn,
            sink=sink,
            suspension_kind="team_preview",
            turn_paused_extras={DEMO_TAPE_FRAME_KEY: dict(tape_meta)},
        )
    except SuspensionPersistError:
        logger.exception(
            "demo_tape.pause_persist_failed",
            message_id=message_id,
            checkpoint_id=checkpoint_id,
        )
        raise
    finally:
        captain_transcript.reset(tr_token)

    if not saved:
        raise RuntimeError(
            f"demo tape pause capture unavailable (no transcript) for {checkpoint_id}"
        )

    # Live order: persist frame, then emit the required card, then pause-end.
    sink.emit(required)
    sink.emit(message_end(FinishReason.PAUSED))
    if not paused_content:
        paused_content = sink.streamed_content() or ""
    if not paused_reasoning:
        paused_reasoning = sink.streamed_reasoning() or ""
    logger.info(
        "demo_tape.paused",
        message_id=message_id,
        checkpoint_id=checkpoint_id,
        next_index=next_index,
        content_chars=len(paused_content),
    )
    return _result_from_sink(
        sink=sink,
        message_id=message_id,
        finish=FinishReason.PAUSED,
        content=paused_content,
        reasoning=paused_reasoning,
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
    transport: PlaybackTransport | None = None,
) -> dict[str, Any]:
    """Play events from ``start_index``; pause on the next required card.

    Event prep (normalize / remint / legacy captain ``run_id`` strip) is the shared
    SINK source adapter (:mod:`agentcore.replay`). This player keeps demo-tape
    application decoration: pacing, team_preview pause wiring, message lifecycle
    alignment with shared bootstrap. When ``transport`` is set (director console),
    speed / pause / burst-seek are read live from that metronome.
    """
    source = prepare_replay_source(
        {"events": events},
        consumer=ConsumerKind.SINK,
        message_id=message_id,
    )
    assert_sink_consumer(source)
    events = list(source.events)
    content_parts: list[str] = [content_seed] if content_seed else []
    reasoning_parts: list[str] = [reasoning_seed] if reasoning_seed else []

    if transport is not None:
        transport.begin_play(message_id=message_id, start_index=start_index)

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
        et_name = event_type(ev)
        payload = dict(ev.get("payload") or {})
        t_ms = int(ev.get("t_ms") or 0)
        ts = event_timestamp(ev)

        # Skip non-emitted types *before* pacing so recorded pause/hesitation gaps
        # (turn_paused, *_resolved, …) do not sleep or advance the clock — resume's
        # first live event then fires immediately (prev_t still None → gap 0).
        if et_name in PAUSE_RESOLVED_KINDS or _as_event_type(et_name) is None:
            i += 1
            continue

        if transport is not None:
            transport.report_position(event_index=i, t_ms=t_ms)
            transport.clear_burst_if_reached(i)

        gap, prev_t = pacing_step(prev_t_ms=prev_t, t_ms=t_ms)
        if transport is not None:
            await transport.await_gap(gap, event_index=i)
        else:
            delay = sleep_ms_for_gap(
                gap_ms=gap, speed=binding.speed, max_gap_ms=binding.max_gap_ms
            )
            if delay > 0:
                await asyncio.sleep(delay)

        if et_name == "team_preview_required":
            # Director seek past this card: emit required+resolved, keep injecting.
            if transport is not None and transport.should_auto_resolve_at(i):
                if not payload.get("checkpoint_id"):
                    payload["checkpoint_id"] = replay_interaction_id(
                        "", message_id=message_id
                    )
                payload["conversation_id"] = conversation_id
                await _emit_auto_resolved_team_preview(
                    sink=sink,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    payload=payload,
                    ts=ts,
                )
                i += 1
                continue

            # Live order: capture+persist first, then emit the card. Remint id here.
            if not payload.get("checkpoint_id"):
                payload["checkpoint_id"] = replay_interaction_id(
                    "", message_id=message_id
                )
            payload["conversation_id"] = conversation_id
            required = team_preview_required(
                checkpoint_id=str(payload["checkpoint_id"]),
                conversation_id=conversation_id,
                workers=list(payload.get("workers") or []),
                tools=list(payload.get("tools") or []),
                primitive=str(payload.get("primitive") or "debate"),
                motion=str(payload.get("motion") or ""),
                form=str(payload.get("form") or ""),
                sides=list(payload.get("sides") or []),
                max_rounds=int(payload.get("max_rounds") or 0),
                thorough=bool(payload.get("thorough", True)),
            )
            if ts:
                required = SSEEvent(
                    type=required.type, payload=required.payload, timestamp=ts
                )
            result = await _pause_team_preview(
                sink=sink,
                binding=binding,
                message_id=message_id,
                conversation_id=conversation_id,
                user_id=user_id,
                user_message=user_message,
                folder_id=folder_id,
                required=required,
                next_index=i + 1,
                journal_writer=journal_writer,
                transport=transport,
            )
            if transport is not None:
                transport.mark_awaiting_interaction(event_index=i, t_ms=t_ms)
            return result

        if et_name in PAUSE_REQUIRED_KINDS:
            # Other durable pause cards (plan_review / ask_user) are not yet wired for
            # tape frames — emit for visibility then continue (dev tape should avoid
            # them). Their ids were reminted at load like every interaction id.
            logger.warning("demo_tape.unhandled_pause_type", type=et_name)
            await _emit(sink, et_name, payload, ts=ts)
            i += 1
            continue

        await _emit(sink, et_name, payload, ts=ts)
        if et_name == "content_delta":
            _accumulate_text(content_parts, et_name, payload)
        elif et_name == "reasoning_delta":
            _accumulate_text(reasoning_parts, et_name, payload)
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
    if transport is not None:
        transport.report_position(event_index=max(0, i - 1), t_ms=int(prev_t or 0))
        transport.mark_finished()
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
    duration_ms = max((int(ev.get("t_ms") or 0) for ev in events), default=0)
    transport = transport_registry.attach(
        conversation_id=conversation_id,
        tape_path=binding.tape_path,
        speed=binding.speed,
        max_gap_ms=binding.max_gap_ms,
        event_count=len(events),
        duration_ms=duration_ms,
        tape_id=binding.tape_path.stem,
    )
    writer = TurnJournalWriter(
        turn_id=message_id,
        conversation_id=conversation_id,
        trace_id=trace_id,
    )
    fact_log = TurnFactLog()
    token = current_journal_writer.set(writer)
    fact_token = current_fact_log.set(fact_log)
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
            transport=transport,
        )
        await writer.flush()
        return _attach_tape_followups(result, tape)
    except Exception as e:
        transport.mark_error(str(e))
        raise
    finally:
        current_fact_log.reset(fact_token)
        current_journal_writer.reset(token)


async def continue_tape_turn(
    *,
    suspension: TeamPreviewSuspension,
    response: CheckpointResponse,
    sink: EventSink,
    folder_id: str | None,
    trace_id: str | None,
) -> dict[str, Any]:
    """Resume a tape paused at team_preview after a real frontend resolve.

    Display open goes through the shared resume bootstrap (message_start +
    turn_paused rehydrate + G6 arm). Tape only answers which event index to
    continue from — no private content channel.
    """
    if not is_demo_tape_frame(suspension):
        raise RuntimeError("continue_tape_turn called on non-tape suspension")

    meta = tape_frame_meta(suspension)
    if not meta.get("tape"):
        raise RuntimeError("demo tape frame missing tape path in turn_paused extras")
    tape_path = Path(str(meta["tape"]))
    next_index = int(meta.get("next_index") or 0)
    speed = float(meta.get("speed") or 1.0)
    max_gap_ms = int(meta.get("max_gap_ms") or 3000)

    # Prefer live director speed over the frozen pause-frame meta.
    live = transport_registry.get(suspension.conversation_id)
    if live is not None:
        speed = live.speed
    binding = TapeBinding(
        conversation_id=suspension.conversation_id,
        tape_path=tape_path,
        speed=speed,
        max_gap_ms=max_gap_ms,
    )
    tape = load_tape(tape_path)
    events = list(tape.get("events") or [])
    duration_ms = max((int(ev.get("t_ms") or 0) for ev in events), default=0)
    transport = transport_registry.attach(
        conversation_id=suspension.conversation_id,
        tape_path=tape_path,
        speed=speed,
        max_gap_ms=max_gap_ms,
        event_count=len(events),
        duration_ms=duration_ms,
        tape_id=tape_path.stem,
    )

    # Shared resume display open (parity with resume_chat_pipeline).
    hydrated = bootstrap_resume_display(
        sink=sink,
        suspension=suspension,
        conversation_id=suspension.conversation_id,
    )
    content_seed = hydrated.pre_pause_content or ""
    reasoning_seed = hydrated.pre_pause_reasoning or ""
    arm_content_reset_reinjection(sink, content_seed)

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
        transport.mark_finished()
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
    fact_log = TurnFactLog(inherited_entries=list(suspension.journal_entries or []))
    token = current_journal_writer.set(writer)
    fact_token = current_fact_log.set(fact_log)
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
            emit_message_start=False,  # bootstrap already emitted message_start
            trace_id=trace_id,
            transport=transport,
        )
        await writer.flush()
        return _attach_tape_followups(result, tape)
    except Exception as e:
        transport.mark_error(str(e))
        raise
    finally:
        current_fact_log.reset(fact_token)
        current_journal_writer.reset(token)
