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
    intro, wrap = _split_captain_content(captain_content, rows)

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

    # Captain reasoning (DERIVED): place each thinking burst at the timeline position
    # it actually occurred, using the process timeline. Falls back to a single
    # post-debate block for tapes without process reasoning.
    events = _place_captain_reasoning(
        events,
        rows,
        fallback_reasoning=captain_reasoning,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )

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


_CAPTAIN_PROCESS_KINDS = (
    "process_reasoning",
    "process_content",
    "process_tool",
    "process_team_preview",
    "process_team",
)


def _captain_content_split_point(rows: list[dict[str, Any]]) -> int | None:
    """Character offset splitting pre-pause prose from post-debate prose.

    Uses the process timeline: the total length of ``process_content`` seen before the
    ``process_team_preview`` card is exactly where the pre-pause captain prose (e.g. the
    case brief) ends in ``messages.content``. Returns ``None`` when there is no team
    preview (nothing to split on) so callers fall back to the heuristic split.
    """
    steps = sorted(
        (
            {
                "seq": r.get("seq") or 0,
                "kind": str(r.get("kind") or ""),
                "payload": dict(r.get("payload") or {}),
            }
            for r in rows
            if str(r.get("kind") or "") in _CAPTAIN_PROCESS_KINDS
        ),
        key=lambda s: s["seq"],
    )
    total = 0
    for step in steps:
        if step["kind"] == "process_team_preview":
            return total
        if step["kind"] == "process_content":
            total += len(str(step["payload"].get("text") or ""))
    return None


def _split_captain_content(content: str, rows: list[dict[str, Any]]) -> tuple[str, str]:
    """Split captain prose into (intro before card, wrap after debate).

    Prefers the exact process-timeline boundary (lossless: ``intro + wrap == content``);
    falls back to :func:`_split_captain_text` when the timeline has no team preview.
    """
    text = content or ""
    if not text:
        return "", ""
    point = _captain_content_split_point(rows)
    if point is not None and 0 < point < len(text):
        return text[:point], text[point:]
    return _split_captain_text(text)


def _captain_reasoning_segments(
    rows: list[dict[str, Any]],
) -> list[tuple[str, tuple[str, ...]]]:
    """Ordered captain reasoning bursts + where each belongs, from the process timeline.

    The turn-level process timeline (``process_*`` rows, no ``run_`` prefix) records the
    captain's narrative in causal order — reasoning, tool, prose, team-preview card. Each
    reasoning burst is anchored to whatever visible step immediately follows it:

      ``("tool", <tool_name>)`` — reasoning that precedes a captain tool call
      ``("intro",)``            — reasoning that precedes the pre-pause captain prose
      ``("preview",)``          — reasoning that directly precedes the team-preview card
      ``("wrap",)``             — reasoning produced after the pause (debate wrap-up)
      ``("end",)``              — trailing reasoning with no following anchor
    """
    steps = [
        {
            "seq": r.get("seq") or 0,
            "kind": str(r.get("kind") or ""),
            "payload": dict(r.get("payload") or {}),
        }
        for r in rows
        if str(r.get("kind") or "") in _CAPTAIN_PROCESS_KINDS
    ]
    steps.sort(key=lambda s: s["seq"])

    segments: list[tuple[str, tuple[str, ...]]] = []
    passed_preview = False
    for i, step in enumerate(steps):
        kind = step["kind"]
        if kind == "process_team_preview":
            passed_preview = True
            continue
        if kind != "process_reasoning":
            continue
        text = str(step["payload"].get("text") or "")
        if not text:
            continue
        if passed_preview:
            segments.append((text, ("wrap",)))
            continue
        anchor: tuple[str, ...] = ("end",)
        for nxt in steps[i + 1 :]:
            nk = nxt["kind"]
            if nk == "process_reasoning":
                continue
            if nk == "process_tool":
                anchor = ("tool", str(nxt["payload"].get("tool_name") or ""))
            elif nk == "process_content":
                anchor = ("intro",)
            elif nk == "process_team_preview":
                anchor = ("preview",)
            else:
                anchor = ("intro",)
            break
        segments.append((text, anchor))
    return segments


def _place_captain_reasoning(
    events: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    *,
    fallback_reasoning: str,
    chunk_size: int,
    chunk_gap_ms: int,
) -> list[dict[str, Any]]:
    """Insert captain ``reasoning_delta`` at the timeline position each burst occurred.

    Anchors come from :func:`_captain_reasoning_segments`. When the journal carries no
    process reasoning (legacy tapes), falls back to a single block after ``debate_result``.
    """
    segments = _captain_reasoning_segments(rows)

    preview_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "team_preview_required"),
        None,
    )
    debate_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "debate_result"),
        None,
    )

    if not segments:
        if not fallback_reasoning:
            return events
        anchor_ms = (
            int(events[debate_idx]["t_ms"])
            if debate_idx is not None
            else (int(events[-1]["t_ms"]) if events else 0)
        )
        block = _delta_events(
            "reasoning_delta",
            fallback_reasoning,
            base_ms=anchor_ms + 50,
            chunk_size=chunk_size,
            chunk_gap_ms=chunk_gap_ms,
        )
        insert_at = (debate_idx + 1) if debate_idx is not None else len(events)
        events[insert_at:insert_at] = block
        return events

    pre_limit = preview_idx if preview_idx is not None else len(events)
    wrap_start_default = (debate_idx + 1) if debate_idx is not None else len(events)

    def _first_content(lo: int, hi: int) -> int | None:
        return next(
            (i for i in range(lo, min(hi, len(events))) if events[i]["kind"] == "content_delta"),
            None,
        )

    inserts: dict[int, list[dict[str, Any]]] = {}
    cursor = 0
    for text, anchor in segments:
        if anchor[0] == "tool":
            name = anchor[1]
            idx = next(
                (
                    i
                    for i in range(cursor, pre_limit)
                    if events[i]["kind"] == "tool_use_start"
                    and str((events[i]["payload"] or {}).get("tool_name") or "") == name
                ),
                None,
            )
            if idx is None:
                idx = pre_limit
        elif anchor[0] == "intro":
            idx = _first_content(cursor, pre_limit)
            if idx is None:
                idx = pre_limit
        elif anchor[0] == "preview":
            idx = pre_limit
        elif anchor[0] == "wrap":
            idx = _first_content(wrap_start_default, len(events))
            if idx is None:
                idx = wrap_start_default
        else:  # end
            idx = len(events)
        cursor = min(max(cursor, idx + 1), len(events))
        if idx < len(events):
            base_ms = int(events[idx - 1]["t_ms"]) if idx > 0 else int(events[idx]["t_ms"])
        elif events:
            base_ms = int(events[-1]["t_ms"])
        else:
            base_ms = 0
        seg_events = _delta_events(
            "reasoning_delta",
            text,
            base_ms=base_ms,
            chunk_size=chunk_size,
            chunk_gap_ms=chunk_gap_ms,
        )
        inserts.setdefault(idx, []).extend(seg_events)

    rebuilt: list[dict[str, Any]] = []
    for i in range(len(events)):
        rebuilt.extend(inserts.get(i, []))
        rebuilt.append(events[i])
    rebuilt.extend(inserts.get(len(events), []))
    return rebuilt


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
