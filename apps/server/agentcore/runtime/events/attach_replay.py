"""Cursor replay for ``GET …/stream`` with ``Last-Event-ID`` (流式回复持久化 §3.6 · P3).

Builds a clear-then-fold replay segment: **full** durable journal facts from the
turn start (header value is observational only — clients clear-then-fold, so a
``> cursor`` tail would drop pre-cursor tool/team structure) + single-block
deltas synthesized from in-flight stream channels (overlay / ``message_final``
splice isomorphic). No ``id:`` on synthetic deltas — they attach after the
nearest durable seq.
"""

from __future__ import annotations

from typing import Any

from agentcore.runtime.events.disposition import DURABLE_EVENT_TYPES
from agentcore.runtime.events.stream_checkpointer import (
    CHANNEL_CAPTAIN_CONTENT,
    CHANNEL_CAPTAIN_REASONING,
    parse_run_channel,
)
from agentcore.runtime.events.types import EventType, SSEEvent
from agentcore.runtime.facts import EXECUTION_ONLY_KINDS, FactKind
from agentcore.runtime.journal.entries import _PROCESS_PREFIX
from agentcore.runtime.runs.types import RunKind

_DURABLE_KIND_VALUES = frozenset(t.value for t in DURABLE_EVENT_TYPES)
_RUN_TERMINAL = frozenset({EventType.RUN_COMPLETED.value, EventType.RUN_FAILED.value})


def journal_rows_to_sse(rows: list[dict[str, Any]]) -> list[SSEEvent]:
    """Convert ``load_after`` rows into live-shaped SSE events (with ``seq`` on DURABLE)."""
    final_outputs: dict[str, dict[str, str]] = {}
    agent_run_ids: dict[str, str] = {}
    for row in rows:
        kind = str(row.get("kind") or "")
        payload = dict(row.get("payload") or {})
        if kind == FactKind.MESSAGE_FINAL.value:
            run_id = payload.get("run_id")
            if run_id:
                final_outputs[str(run_id)] = {
                    "content": payload.get("content") or "",
                    "reasoning": payload.get("reasoning") or "",
                }
        elif kind == EventType.RUN_STARTED.value and payload.get("kind") == RunKind.AGENT.value:
            run_id = payload.get("run_id")
            if run_id:
                agent_run_ids[str(run_id)] = payload.get("agent_id") or ""

    out: list[SSEEvent] = []
    for row in rows:
        kind = str(row.get("kind") or "")
        payload = dict(row.get("payload") or {})
        ts = row.get("ts") or ""
        seq_raw = row.get("seq")
        seq_i = int(seq_raw) if seq_raw is not None else None

        if kind == FactKind.MESSAGE_FINAL.value:
            continue
        if kind in EXECUTION_ONLY_KINDS or kind.startswith(_PROCESS_PREFIX):
            continue
        if kind not in _DURABLE_KIND_VALUES:
            continue

        if kind in _RUN_TERMINAL:
            run_id = payload.get("run_id")
            final = final_outputs.get(str(run_id)) if run_id else None
            agent_id = None
            if run_id:
                agent_id = agent_run_ids.get(str(run_id)) or payload.get("agent_id") or None
            if final is not None and agent_id is not None and run_id:
                if final["reasoning"]:
                    out.append(
                        SSEEvent(
                            type=EventType.RUN_REASONING_DELTA,
                            payload={
                                "run_id": run_id,
                                "agent_id": agent_id,
                                "delta": final["reasoning"],
                            },
                            timestamp=ts,
                        )
                    )
                if final["content"]:
                    out.append(
                        SSEEvent(
                            type=EventType.RUN_OUTPUT_DELTA,
                            payload={
                                "run_id": run_id,
                                "agent_id": agent_id,
                                "delta": final["content"],
                            },
                            timestamp=ts,
                        )
                    )

        out.append(
            SSEEvent(
                type=EventType(kind),
                payload=payload,
                timestamp=ts,
                seq=seq_i,
            )
        )
    return out


def synthesize_segment_deltas(
    *,
    by_channel: dict[str, str],
    agent_run_ids: dict[str, str],
    covered_run_ids: set[str],
) -> list[SSEEvent]:
    """Single-block deltas from stream_state / memory (P1 overlay isomorphic)."""
    extra: list[SSEEvent] = []
    cap_reasoning = by_channel.get(CHANNEL_CAPTAIN_REASONING) or ""
    cap_content = by_channel.get(CHANNEL_CAPTAIN_CONTENT) or ""
    if cap_reasoning:
        extra.append(SSEEvent(type=EventType.REASONING_DELTA, payload={"delta": cap_reasoning}))
    if cap_content:
        extra.append(SSEEvent(type=EventType.CONTENT_DELTA, payload={"delta": cap_content}))

    partial: dict[str, dict[str, str]] = {}
    for channel, text in by_channel.items():
        parsed = parse_run_channel(channel)
        if parsed is None or not text:
            continue
        run_id, kind = parsed
        slot = partial.setdefault(run_id, {"content": "", "reasoning": ""})
        if kind == "output":
            slot["content"] = text
        else:
            slot["reasoning"] = text

    for run_id, texts in partial.items():
        if run_id in covered_run_ids or run_id not in agent_run_ids:
            continue
        agent_id = agent_run_ids.get(run_id) or ""
        if texts.get("reasoning"):
            extra.append(
                SSEEvent(
                    type=EventType.RUN_REASONING_DELTA,
                    payload={
                        "run_id": run_id,
                        "agent_id": agent_id,
                        "delta": texts["reasoning"],
                    },
                )
            )
        if texts.get("content"):
            extra.append(
                SSEEvent(
                    type=EventType.RUN_OUTPUT_DELTA,
                    payload={
                        "run_id": run_id,
                        "agent_id": agent_id,
                        "delta": texts["content"],
                    },
                )
            )
    return extra


async def build_cursor_replay(
    *,
    turn_id: str,
    after_seq: int,
    memory_channels: dict[str, str],
    memory_agent_ids: dict[str, str],
) -> list[SSEEvent]:
    """Full-turn durable journal + in-flight segment synthesis (clear-then-fold).

    ``after_seq`` is the client's ``Last-Event-ID`` — kept for observability /
    future cross-process cursors, but **not** used to filter rows. Clients reset
    local process/execution before folding, so the replay must include
    pre-cursor structure (tools / team graph), not only ``seq > after_seq``.
    """
    from agentcore.conversation.store import get_conversation_store
    from agentcore.core.logging import get_logger
    from agentcore.db.base import telemetry_session_factory
    from agentcore.db.repositories.runs import TurnJournalRepository

    get_logger(__name__).debug(
        "attach.cursor_replay",
        turn_id=turn_id,
        last_event_id=after_seq,
    )

    async with telemetry_session_factory() as db:
        # Full turn from seq 0 (``seq > -1``); header value is observational only.
        rows = await TurnJournalRepository(db).load_after(turn_id, -1)

    events = journal_rows_to_sse(rows)

    agent_ids = dict(memory_agent_ids)
    covered: set[str] = set()
    for ev in events:
        if ev.type == EventType.RUN_STARTED and ev.payload.get("kind") == RunKind.AGENT.value:
            rid = ev.payload.get("run_id")
            if rid:
                agent_ids.setdefault(str(rid), ev.payload.get("agent_id") or "")
        if ev.type in (EventType.RUN_OUTPUT_DELTA, EventType.RUN_REASONING_DELTA):
            rid = ev.payload.get("run_id")
            if rid:
                covered.add(str(rid))

    by_channel = dict(memory_channels)
    if not by_channel:
        store = get_conversation_store()
        segments = await store.list_stream_segments(turn_id=turn_id)
        by_channel = {
            str(s["channel"]): str(s.get("text") or "")
            for s in segments
            if s.get("channel") and s.get("text")
        }

    events.extend(
        synthesize_segment_deltas(
            by_channel=by_channel,
            agent_run_ids=agent_ids,
            covered_run_ids=covered,
        )
    )
    return events
