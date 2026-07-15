"""Export a turn_journal (+ message body) into a demo tape JSON file."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agentcore.demo_tape.schema import (
    CHUNKABLE_DELTA_KINDS,
    TAPE_FORMAT_VERSION,
    chunk_text,
    parse_iso_ms,
    should_export_kind,
)


def build_tape_events(
    rows: list[dict[str, Any]],
    *,
    captain_content: str = "",
    captain_reasoning: str = "",
    chunk_size: int = 28,
    chunk_gap_ms: int = 35,
) -> list[dict[str, Any]]:
    """Flatten journal rows into timed live-shaped tape events.

    - Skips process / execution-only / recorded ``*_resolved`` rows.
    - Re-chunks full-text deltas into typing-sized pieces with synthetic ``t_ms``.
    - Appends captain ``content_delta`` / ``reasoning_delta`` from the message body
      near the end (journal does not store DERIVED captain deltas).

    Causal order follows journal ``seq`` (re-chunked pieces stay contiguous). Events are
    **not** re-sorted by ``(t_ms, kind)`` — that previously put ``run_context`` before
    ``run_started`` on equal timestamps and broke debate beat projection.
    """
    raw: list[dict[str, Any]] = []
    for row in rows:
        kind = str(row.get("kind") or "")
        if not should_export_kind(kind):
            continue
        payload = dict(row.get("payload") or {})
        ts = row.get("ts")
        t_ms = parse_iso_ms(ts if isinstance(ts, str) else None)
        raw.append(
            {
                "kind": kind,
                "payload": payload,
                "ts": ts,
                "t_ms": t_ms,
                "seq": row.get("seq"),
            }
        )

    # Origin = first *parsed* timestamp. Do not use a forward-fill 0 as origin —
    # that would leave later absolute epoch values as bogus relative t_ms (multi-minute
    # false gaps once max_gap_ms no longer masks them).
    first_known = next((i for i, ev in enumerate(raw) if ev["t_ms"] is not None), None)
    if first_known is None:
        for ev in raw:
            ev["t_ms"] = 0
        origin = 0
    else:
        origin = int(raw[first_known]["t_ms"])
        for i in range(first_known):
            raw[i]["t_ms"] = origin
        last_ms = origin
        for i in range(first_known, len(raw)):
            if raw[i]["t_ms"] is None:
                raw[i]["t_ms"] = last_ms
            else:
                last_ms = int(raw[i]["t_ms"])
        for ev in raw:
            ev["t_ms"] = max(0, int(ev["t_ms"]) - origin)

    # Re-chunk long deltas in place (contiguous) so process coalescing + fold order stay valid.
    # Fit chunk times into [base, next_event_t_ms) so synthetic typing never overshoots the
    # next journal anchor (overshoot → player clock rewind → double-slept real gaps).
    events: list[dict[str, Any]] = []
    for idx, ev in enumerate(raw):
        kind = ev["kind"]
        payload = ev["payload"]
        if kind in CHUNKABLE_DELTA_KINDS:
            text = str(payload.get("delta") or "")
            parts = chunk_text(text, size=chunk_size)
            if not parts:
                continue
            base = int(ev["t_ms"])
            next_t = int(raw[idx + 1]["t_ms"]) if idx + 1 < len(raw) else None
            step = _chunk_step_ms(
                base_ms=base,
                n_parts=len(parts),
                chunk_gap_ms=chunk_gap_ms,
                next_t_ms=next_t,
            )
            for i, part in enumerate(parts):
                chunk_payload = dict(payload)
                chunk_payload["delta"] = part
                events.append(
                    {
                        "kind": kind,
                        "payload": chunk_payload,
                        "ts": ev["ts"],
                        "t_ms": base + i * step,
                    }
                )
            continue
        events.append(
            {
                "kind": kind,
                "payload": payload,
                "ts": ev["ts"],
                "t_ms": ev["t_ms"],
            }
        )

    # Captain bubble (DERIVED): insert intro before team_preview, wrap after debate_result.
    # Keep list order — never sort by kind.
    preview_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "team_preview_required"),
        None,
    )
    debate_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "debate_result"),
        None,
    )
    intro, wrap = _split_captain_text(captain_content)

    if captain_reasoning:
        anchor_ms = (
            int(events[debate_idx]["t_ms"])
            if debate_idx is not None
            else (int(events[-1]["t_ms"]) if events else 0)
        )
        reasoning_events = _delta_events(
            "reasoning_delta",
            captain_reasoning,
            base_ms=anchor_ms + 50,
            chunk_size=chunk_size,
            chunk_gap_ms=chunk_gap_ms,
        )
        insert_at = (debate_idx + 1) if debate_idx is not None else len(events)
        events[insert_at:insert_at] = reasoning_events
        if preview_idx is not None and preview_idx >= insert_at:
            preview_idx += len(reasoning_events)
        if debate_idx is not None and debate_idx >= insert_at:
            debate_idx += len(reasoning_events)

    if intro and preview_idx is not None:
        preview_ms = int(events[preview_idx]["t_ms"])
        prev_ms = int(events[preview_idx - 1]["t_ms"]) if preview_idx > 0 else 0
        n_parts = max(1, len(chunk_text(intro, size=chunk_size)))
        # Fit intro into (prev_ms, preview_ms] — never before the prior event.
        span = max(0, preview_ms - prev_ms)
        if n_parts <= 1 or span <= 0:
            cursor = preview_ms
            step = 0
        else:
            step = min(chunk_gap_ms, max(1, span // n_parts))
            cursor = max(prev_ms, preview_ms - step * (n_parts - 1))
        intro_events = _delta_events(
            "content_delta",
            intro,
            base_ms=cursor,
            chunk_size=chunk_size,
            chunk_gap_ms=step if step > 0 else chunk_gap_ms,
        )
        if step == 0:
            for ev in intro_events:
                ev["t_ms"] = preview_ms
        events[preview_idx:preview_idx] = intro_events
        if debate_idx is not None and debate_idx >= preview_idx:
            debate_idx += len(intro_events)

    rest = wrap if intro else captain_content
    if rest:
        anchor_ms = (
            int(events[debate_idx]["t_ms"])
            if debate_idx is not None
            else (int(events[-1]["t_ms"]) if events else 0)
        )
        wrap_events = _delta_events(
            "content_delta",
            rest,
            base_ms=anchor_ms + 200,
            chunk_size=chunk_size,
            chunk_gap_ms=chunk_gap_ms,
        )
        insert_at = (debate_idx + 1) if debate_idx is not None else len(events)
        events[insert_at:insert_at] = wrap_events

    _clamp_monotonic_t_ms(events)
    return events


def _chunk_step_ms(
    *,
    base_ms: int,
    n_parts: int,
    chunk_gap_ms: int,
    next_t_ms: int | None,
) -> int:
    """Typing step that stays strictly before the next journal anchor when possible."""
    if n_parts <= 1:
        return 0
    if next_t_ms is None:
        return max(0, int(chunk_gap_ms))
    room = int(next_t_ms) - int(base_ms)
    if room <= 0:
        return 0
    # base + (n-1)*step < next_t  ⇒  step <= (room - 1) / (n - 1) when room > 0
    max_step = max(0, (room - 1) // (n_parts - 1)) if n_parts > 1 else 0
    return min(max(0, int(chunk_gap_ms)), max_step)


def _clamp_monotonic_t_ms(events: list[dict[str, Any]]) -> None:
    """In-place: ensure t_ms never goes backwards (safety net after inserts)."""
    last = 0
    for ev in events:
        t = max(last, int(ev.get("t_ms") or 0))
        ev["t_ms"] = t
        last = t


def _delta_events(
    kind: str,
    text: str,
    *,
    base_ms: int,
    chunk_size: int,
    chunk_gap_ms: int,
) -> list[dict[str, Any]]:
    parts = chunk_text(text, size=chunk_size)
    out: list[dict[str, Any]] = []
    for i, part in enumerate(parts):
        out.append(
            {
                "kind": kind,
                "payload": {"delta": part},
                "ts": None,
                "t_ms": int(base_ms) + i * chunk_gap_ms,
            }
        )
    return out


def _split_captain_text(content: str) -> tuple[str, str]:
    """Lossless split: first section before ``---`` / double newline = intro."""
    text = content or ""
    if not text:
        return "", ""
    for sep in ("\n\n---\n\n", "\n---\n", "\n\n"):
        if sep in text:
            head, tail = text.split(sep, 1)
            if 40 <= len(head) <= 800:
                return head + sep, tail
    if len(text) > 500:
        return text[:400], text[400:]
    return "", text


def build_tape_document(
    *,
    rows: list[dict[str, Any]],
    meta: dict[str, Any],
    captain_content: str = "",
    captain_reasoning: str = "",
    user_prompt: str = "",
    chunk_size: int = 28,
    chunk_gap_ms: int = 35,
) -> dict[str, Any]:
    events = build_tape_events(
        rows,
        captain_content=captain_content,
        captain_reasoning=captain_reasoning,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )
    duration_ms = int(events[-1]["t_ms"]) if events else 0
    return {
        "version": TAPE_FORMAT_VERSION,
        "meta": {
            **meta,
            "user_prompt": user_prompt,
            "duration_ms": duration_ms,
            "event_count": len(events),
        },
        "events": events,
    }


def write_tape(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_tape(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "events" not in data:
        raise ValueError(f"invalid tape file: {path}")
    return data
