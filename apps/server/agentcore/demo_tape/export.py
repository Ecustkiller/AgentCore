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

# Synthetic typing beat gaps: fill the real journal window when possible, but never
# machine-gun faster than ~15ms or drag a single gap past ~1.2s.
MIN_CHUNK_GAP_MS = 15
MAX_CHUNK_GAP_MS = 1200

# CEO「正在生成 委派任务 · N 字」heartbeat ticks (EPHEMERAL tool_progress on tape).
_DELEGATE_COMPOSE_STEPS = 8
_ORCH_TOOL_NAMES = frozenset({"debate", "delegate"})


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
    - Re-chunks / synthesizes deltas so typing fills each real time window.
    - Rebuilds worker ``run_*_delta`` from ``message_final`` + ``run_process_*``.
    - Emits EPHEMERAL ``tool_progress`` compose ticks before the orchestration tool.
    - Appends captain ``content_delta`` / ``reasoning_delta`` from the message body
      (journal does not store DERIVED captain deltas).

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
            times = _spread_times(
                lo_ms=base,
                hi_ms=next_t if next_t is not None else base + len(parts) * chunk_gap_ms,
                n_parts=len(parts),
            )
            for part, t in zip(parts, times, strict=True):
                chunk_payload = dict(payload)
                chunk_payload["delta"] = part
                events.append(
                    {
                        "kind": kind,
                        "payload": chunk_payload,
                        "ts": ev["ts"],
                        "t_ms": t,
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

    events = _inject_worker_run_deltas(
        events,
        rows,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )

    intro, wrap = _split_captain_content(captain_content, rows)

    # Tool / preview / end reasoning in their own windows. Intro + wrap bursts are
    # deferred so they share real journal windows with their prose (reasoning first).
    events, intro_reasoning, wrap_reasoning = _place_captain_reasoning(
        events,
        rows,
        fallback_reasoning=captain_reasoning,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )

    events = _inject_pre_orch_synthetics(
        events,
        intro_text=intro,
        intro_reasoning=intro_reasoning,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )

    # Closing window: last orch tool_use_end → run_completed (reasoning then content).
    rest = wrap if intro else captain_content
    events = _inject_closing_synthetics(
        events,
        wrap_text=rest,
        wrap_reasoning=wrap_reasoning,
        chunk_size=chunk_size,
        chunk_gap_ms=chunk_gap_ms,
    )

    _clamp_monotonic_t_ms(events)
    return events


def _spread_times(
    *,
    lo_ms: int,
    hi_ms: int,
    n_parts: int,
    min_gap: int = MIN_CHUNK_GAP_MS,
    max_gap: int = MAX_CHUNK_GAP_MS,
    prefer_gap_ms: int | None = None,
    align_end: bool = False,
) -> list[int]:
    """Timestamps for ``n_parts`` beats in ``[lo_ms, hi_ms)``, filling the window.

    - Tiny / inverted window → every beat at ``lo_ms`` (no overshoot, no rewind).
    - Otherwise step = clamp(floor fit of full window, min_gap..max_gap); place from
      ``lo_ms`` forward so long think windows are occupied instead of end-packed.
    - ``prefer_gap_ms`` (legacy trailing wrap) caps the ideal when no real ``hi`` exists.
    - ``align_end``: when max_gap clamp leaves unused tail, shift the block so the last
      beat hugs ``hi`` (worker final gap → run_completed; avoids a dead node tail).
    """
    lo = int(lo_ms)
    hi = int(hi_ms)
    n = int(n_parts)
    if n <= 0:
        return []
    if n == 1:
        return [hi - 1 if align_end and hi > lo else lo]
    span = hi - lo
    if span <= 0:
        return [lo] * n
    # Last beat strictly before hi when possible.
    max_fit = max(0, (span - 1) // (n - 1))
    if max_fit <= 0:
        return [lo] * n
    ideal = (
        min(max_fit, max(0, int(prefer_gap_ms)))
        if prefer_gap_ms is not None
        else max_fit
    )
    if max_fit >= min_gap:
        step = min(max_gap, max(min_gap, ideal))
        step = min(step, max_fit)
    else:
        # Window too small for min_gap — still differentiate when max_fit > 0.
        step = max_fit
    times = [lo + i * step for i in range(n)]
    if align_end and times[-1] < hi - 1:
        shift = (hi - 1) - times[-1]
        times = [t + shift for t in times]
    return times


def _split_window_by_beats(
    lo_ms: int,
    hi_ms: int,
    beat_counts: list[int],
) -> list[tuple[int, int]]:
    """Proportionally partition ``[lo, hi)`` across segments by beat count."""
    total = sum(max(0, int(n)) for n in beat_counts)
    if not beat_counts:
        return []
    lo, hi = int(lo_ms), int(hi_ms)
    if total <= 0 or hi <= lo:
        return [(lo, lo) for _ in beat_counts]
    span = hi - lo
    out: list[tuple[int, int]] = []
    cursor = lo
    for i, n in enumerate(beat_counts):
        n = max(0, int(n))
        if i == len(beat_counts) - 1:
            out.append((cursor, hi))
            break
        seg = (span * n) // total if total else 0
        out.append((cursor, cursor + seg))
        cursor += seg
    return out


def _delta_events_in_window(
    kind: str,
    text: str,
    *,
    lo_ms: int,
    hi_ms: int,
    chunk_size: int,
    payload_base: dict[str, Any],
    prefer_gap_ms: int | None = None,
    align_end: bool = False,
) -> list[dict[str, Any]]:
    parts = chunk_text(text, size=chunk_size)
    if not parts:
        return []
    times = _spread_times(
        lo_ms=lo_ms,
        hi_ms=hi_ms,
        n_parts=len(parts),
        prefer_gap_ms=prefer_gap_ms,
        align_end=align_end,
    )
    out: list[dict[str, Any]] = []
    for part, t in zip(parts, times, strict=True):
        payload = dict(payload_base)
        payload["delta"] = part
        out.append({"kind": kind, "payload": payload, "ts": None, "t_ms": t})
    return out


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
    """Legacy helper: fixed-gap chunks from ``base_ms`` (tests / simple fallbacks)."""
    return _delta_events_in_window(
        kind,
        text,
        lo_ms=base_ms,
        hi_ms=int(base_ms)
        + max(int(chunk_gap_ms), MIN_CHUNK_GAP_MS)
        * max(1, len(chunk_text(text, size=chunk_size))),
        chunk_size=chunk_size,
        payload_base={},
        prefer_gap_ms=chunk_gap_ms,
    )


def delegation_compose_chars(payload: dict[str, Any]) -> int:
    """Total chars of the delegation/debate arguments the CEO is assembling."""
    parts: list[str] = [str(payload.get("motion") or "")]
    for side in payload.get("sides") or []:
        if isinstance(side, dict):
            parts.append(str(side.get("name") or ""))
            parts.append(str(side.get("stance") or ""))
    for worker in payload.get("workers") or []:
        if isinstance(worker, dict):
            parts.append(str(worker.get("role") or ""))
            parts.append(str(worker.get("task") or ""))
    return sum(len(p) for p in parts)


# Back-compat alias used by older call sites / tests.
_delegation_compose_chars = delegation_compose_chars


def _orchestration_tool_index(
    events: list[dict[str, Any]],
    *,
    before: int | None,
) -> int | None:
    """Index of captain orchestration ``tool_use_start`` (debate/delegate, no run_id)."""
    hi = before if before is not None else len(events)
    for i in range(hi):
        ev = events[i]
        if ev["kind"] != "tool_use_start":
            continue
        p = ev.get("payload") or {}
        if p.get("run_id"):
            continue
        name = str(p.get("tool_name") or p.get("name") or "")
        if name in _ORCH_TOOL_NAMES:
            return i
    return None


def _orch_tool_name(
    events: list[dict[str, Any]],
    *,
    orch_idx: int | None,
    preview_payload: dict[str, Any],
) -> str:
    if orch_idx is not None:
        op = events[orch_idx].get("payload") or {}
        name = str(op.get("tool_name") or op.get("name") or "")
        if name in _ORCH_TOOL_NAMES:
            return name
    prim = str(preview_payload.get("primitive") or preview_payload.get("form") or "")
    if prim in _ORCH_TOOL_NAMES:
        return prim
    return "debate" if "debate" in prim else "delegate"


def _inject_pre_orch_synthetics(
    events: list[dict[str, Any]],
    *,
    intro_text: str,
    intro_reasoning: list[str],
    chunk_size: int,
    chunk_gap_ms: int,
) -> list[dict[str, Any]]:
    """Insert intro-anchored reasoning + case brief + compose ticks before orch / card.

    All three share the real journal window (prior anchor → orch tool or team_preview),
    split by beat count so a long think gap is filled instead of end-packed.
    """
    preview_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "team_preview_required"),
        None,
    )
    if preview_idx is None and not intro_text and not intro_reasoning:
        return events

    orch_idx = _orchestration_tool_index(
        events, before=preview_idx if preview_idx is not None else len(events)
    )
    end_idx = orch_idx if orch_idx is not None else preview_idx
    if end_idx is None:
        return events

    preview_payload = (
        dict(events[preview_idx].get("payload") or {}) if preview_idx is not None else {}
    )
    tool_name = _orch_tool_name(
        events, orch_idx=orch_idx, preview_payload=preview_payload
    )
    total_chars = delegation_compose_chars(preview_payload)

    # Segment list in causal order: deferred reasoning → intro → compose ticks.
    segments: list[tuple[str, str, dict[str, Any]]] = []
    for text in intro_reasoning:
        if text:
            segments.append(("reasoning_delta", text, {}))
    if intro_text:
        segments.append(("content_delta", intro_text, {}))

    compose_n = 0
    if total_chars > 0:
        compose_n = _DELEGATE_COMPOSE_STEPS
        # Placeholder text length only for beat budgeting; real payloads set below.
        segments.append(("tool_progress", "x" * compose_n, {}))

    if not segments:
        return events

    lo_ms = int(events[end_idx - 1]["t_ms"]) if end_idx > 0 else 0
    hi_ms = int(events[end_idx]["t_ms"])

    beat_counts: list[int] = []
    for kind, text, _ in segments:
        if kind == "tool_progress":
            beat_counts.append(compose_n)
        else:
            beat_counts.append(max(1, len(chunk_text(text, size=chunk_size))))
    windows = _split_window_by_beats(lo_ms, hi_ms, beat_counts)

    bundled: list[dict[str, Any]] = []
    for (kind, text, _), (w_lo, w_hi), n_beats in zip(
        segments, windows, beat_counts, strict=True
    ):
        if kind == "tool_progress":
            times = _spread_times(
                lo_ms=w_lo,
                hi_ms=w_hi,
                n_parts=n_beats,
                prefer_gap_ms=chunk_gap_ms if w_hi <= w_lo else None,
            )
            for i, t in enumerate(times):
                chars = max(1, round(total_chars * (i + 1) / n_beats))
                bundled.append(
                    {
                        "kind": "tool_progress",
                        "payload": {"tool_name": tool_name, "chars": chars},
                        "ts": None,
                        "t_ms": t,
                    }
                )
            continue
        bundled.extend(
            _delta_events_in_window(
                kind,
                text,
                lo_ms=w_lo,
                hi_ms=w_hi,
                chunk_size=chunk_size,
                payload_base={},
            )
        )

    events[end_idx:end_idx] = bundled
    return events


def _find_closing_window(
    events: list[dict[str, Any]],
) -> tuple[int, int, int] | None:
    """Locate the captain closing window: last orch tool end → run_completed.

    Returns ``(lo_ms, insert_at, hi_ms)`` where deltas insert at ``insert_at``
    (before ``run_completed``) and fill ``[lo_ms, hi_ms)``.

    Prefer the last debate/delegate ``tool_use_end`` and the following
    ``run_completed``. Fall back to ``debate_result`` → following ``run_completed``
    (or end of tape) when the orch tool end is missing.
    """
    orch_end: int | None = None
    for i, ev in enumerate(events):
        if ev["kind"] != "tool_use_end":
            continue
        p = ev.get("payload") or {}
        name = str(p.get("tool_name") or p.get("name") or "")
        if name in _ORCH_TOOL_NAMES:
            orch_end = i

    anchor = orch_end
    if anchor is None:
        anchor = next(
            (i for i, e in enumerate(events) if e["kind"] == "debate_result"),
            None,
        )
    if anchor is None:
        return None

    completed = next(
        (
            j
            for j in range(anchor + 1, len(events))
            if events[j]["kind"] == "run_completed"
        ),
        None,
    )
    lo_ms = int(events[anchor]["t_ms"])
    if completed is not None:
        return lo_ms, completed, int(events[completed]["t_ms"])
    # No run_completed after the anchor — append at end; synthetic hi from last beat.
    hi_ms = int(events[-1]["t_ms"]) + 1 if events else lo_ms + 1
    return lo_ms, len(events), hi_ms


def _inject_closing_synthetics(
    events: list[dict[str, Any]],
    *,
    wrap_text: str,
    wrap_reasoning: list[str],
    chunk_size: int,
    chunk_gap_ms: int,
) -> list[dict[str, Any]]:
    """Insert post-pause captain reasoning + wrap prose into the closing window.

    Causal order is always reasoning → content. Beats fill the real journal span
    (last orch ``tool_use_end`` → ``run_completed``); the final segment uses
    ``align_end`` so the last delta hugs ``run_completed``.
    """
    segments: list[tuple[str, str]] = []
    for text in wrap_reasoning:
        if text:
            segments.append(("reasoning_delta", text))
    if wrap_text:
        segments.append(("content_delta", wrap_text))
    if not segments:
        return events

    window = _find_closing_window(events)
    if window is None:
        # No debate / orch anchor — append after the last event with prefer_gap.
        base = int(events[-1]["t_ms"]) if events else 0
        bundled: list[dict[str, Any]] = []
        cursor = base
        for kind, text in segments:
            block = _delta_events(
                kind,
                text,
                base_ms=cursor,
                chunk_size=chunk_size,
                chunk_gap_ms=chunk_gap_ms,
            )
            bundled.extend(block)
            if block:
                cursor = int(block[-1]["t_ms"]) + max(chunk_gap_ms, MIN_CHUNK_GAP_MS)
        events.extend(bundled)
        return events

    lo_ms, insert_at, hi_ms = window
    beat_counts = [
        max(1, len(chunk_text(text, size=chunk_size))) for _, text in segments
    ]
    windows = _split_window_by_beats(lo_ms, hi_ms, beat_counts)

    bundled: list[dict[str, Any]] = []
    last_i = len(segments) - 1
    for i, ((kind, text), (w_lo, w_hi)) in enumerate(
        zip(segments, windows, strict=True)
    ):
        bundled.extend(
            _delta_events_in_window(
                kind,
                text,
                lo_ms=w_lo,
                hi_ms=w_hi,
                chunk_size=chunk_size,
                payload_base={},
                prefer_gap_ms=chunk_gap_ms if w_hi <= w_lo else None,
                align_end=(i == last_i),
            )
        )

    events[insert_at:insert_at] = bundled
    return events


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
    # point == len(text) → all prose is pre-pause (intro only, no wrap).
    if point is not None and 0 <= point <= len(text):
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
    chunk_gap_ms: int = 35,
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    """Insert captain ``reasoning_delta`` at the timeline position each burst occurred.

    Anchors come from :func:`_captain_reasoning_segments`. Tool / preview / end bursts
    are inserted here into their (prev → anchor) windows. Intro and wrap bursts are
    *deferred* — returned so :func:`_inject_pre_orch_synthetics` /
    :func:`_inject_closing_synthetics` can share those windows with prose (reasoning
    always before content).

    When the journal carries no process reasoning (legacy tapes), ``fallback_reasoning``
    is returned as a single wrap burst for the closing window.

    ``chunk_gap_ms`` is accepted for call-site symmetry; tool/preview windows use the
    real journal span (no prefer-gap packing).
    """
    del chunk_gap_ms  # window packing uses real journal span only
    segments = _captain_reasoning_segments(rows)
    intro_deferred: list[str] = []
    wrap_deferred: list[str] = []

    preview_idx = next(
        (i for i, e in enumerate(events) if e["kind"] == "team_preview_required"),
        None,
    )

    if not segments:
        if fallback_reasoning:
            wrap_deferred.append(fallback_reasoning)
        return events, intro_deferred, wrap_deferred

    pre_limit = preview_idx if preview_idx is not None else len(events)

    plans: list[tuple[int, str]] = []
    cursor = 0
    for text, anchor in segments:
        if anchor[0] == "intro":
            intro_deferred.append(text)
            continue
        if anchor[0] == "wrap":
            wrap_deferred.append(text)
            continue
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
        elif anchor[0] == "preview":
            idx = pre_limit
        else:  # end
            idx = len(events)
        cursor = min(max(cursor, idx), len(events))
        plans.append((idx, text))

    by_idx: dict[int, list[str]] = {}
    for idx, text in plans:
        by_idx.setdefault(idx, []).append(text)

    inserts: dict[int, list[dict[str, Any]]] = {}
    for idx, texts in by_idx.items():
        hi_ms = (
            int(events[idx]["t_ms"])
            if idx < len(events)
            else (int(events[-1]["t_ms"]) + 1 if events else 1)
        )
        lo_ms = int(events[idx - 1]["t_ms"]) if idx > 0 else 0
        beat_counts = [max(1, len(chunk_text(t, size=chunk_size))) for t in texts]
        windows = _split_window_by_beats(lo_ms, hi_ms, beat_counts)
        bundled: list[dict[str, Any]] = []
        for text, (w_lo, w_hi) in zip(texts, windows, strict=True):
            bundled.extend(
                _delta_events_in_window(
                    "reasoning_delta",
                    text,
                    lo_ms=w_lo,
                    hi_ms=w_hi,
                    chunk_size=chunk_size,
                    payload_base={},
                )
            )
        inserts[idx] = bundled

    rebuilt: list[dict[str, Any]] = []
    for i in range(len(events)):
        rebuilt.extend(inserts.get(i, []))
        rebuilt.append(events[i])
    rebuilt.extend(inserts.get(len(events), []))
    return rebuilt, intro_deferred, wrap_deferred


def _message_finals_by_run(rows: list[dict[str, Any]]) -> dict[str, dict[str, str]]:
    """run_id → {content, reasoning} from journal ``message_final`` facts."""
    out: dict[str, dict[str, str]] = {}
    for r in rows:
        if str(r.get("kind") or "") != "message_final":
            continue
        p = dict(r.get("payload") or {})
        run_id = p.get("run_id")
        if not run_id:
            continue
        out[str(run_id)] = {
            "content": str(p.get("content") or ""),
            "reasoning": str(p.get("reasoning") or ""),
        }
    return out


def _run_process_steps_by_run(
    rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """run_id → ordered run_process_* steps (payload without needing kind prefix)."""
    steps: list[tuple[int, str, dict[str, Any]]] = []
    for r in rows:
        kind = str(r.get("kind") or "")
        if not kind.startswith("run_process_"):
            continue
        p = dict(r.get("payload") or {})
        run_id = p.get("run_id")
        if not run_id:
            continue
        suffix = kind[len("run_process_") :]
        step = {k: v for k, v in p.items() if k != "run_id"}
        step.setdefault("kind", suffix)
        steps.append((int(r.get("seq") or 0), str(run_id), step))
    steps.sort(key=lambda x: x[0])
    out: dict[str, list[dict[str, Any]]] = {}
    for _, run_id, step in steps:
        out.setdefault(run_id, []).append(step)
    return out


def _agent_run_ids(events: list[dict[str, Any]]) -> dict[str, str]:
    """run_id → agent_id for kind=agent runs (captain excluded)."""
    out: dict[str, str] = {}
    for ev in events:
        if ev["kind"] != "run_started":
            continue
        p = ev.get("payload") or {}
        if p.get("kind") != "agent":
            continue
        run_id = p.get("run_id")
        if run_id:
            out[str(run_id)] = str(p.get("agent_id") or "")
    return out


def _run_text_segments(
    process_steps: list[dict[str, Any]],
    *,
    final_content: str,
    final_reasoning: str,
) -> list[tuple[str, str]]:
    """Ordered (channel, text) segments for one run; channel is reasoning|content|tool.

    Prefers process-timeline segmentation when step texts are a prefix-partition of the
    ``message_final`` fields (byte fidelity). Otherwise: reasoning then content.
    """
    r_buf = final_reasoning
    c_buf = final_content
    segs: list[tuple[str, str]] = []
    ok = True
    for step in process_steps:
        sk = str(step.get("kind") or "")
        if sk == "tool":
            segs.append(("tool", str(step.get("tool_name") or "")))
            continue
        if sk == "reasoning":
            t = str(step.get("text") or "")
            if not t:
                continue
            if r_buf.startswith(t):
                segs.append(("reasoning", t))
                r_buf = r_buf[len(t) :]
            else:
                ok = False
                break
        elif sk == "content":
            t = str(step.get("text") or "")
            if not t:
                continue
            if c_buf.startswith(t):
                segs.append(("content", t))
                c_buf = c_buf[len(t) :]
            else:
                ok = False
                break
    if ok:
        if r_buf:
            segs.append(("reasoning", r_buf))
        if c_buf:
            segs.append(("content", c_buf))
        # Drop pure-tool-only if no text left anywhere.
        if any(ch in ("reasoning", "content") for ch, _ in segs):
            return segs

    # Fallback: single reasoning block then content (no process / mismatch).
    fallback: list[tuple[str, str]] = []
    if final_reasoning:
        fallback.append(("reasoning", final_reasoning))
    if final_content:
        fallback.append(("content", final_content))
    return fallback


def _assign_beats_to_gaps(
    beats: list[tuple[int, str, str]],
    capacities: list[int],
) -> list[list[tuple[str, str]]]:
    """Assign ordered text beats to gaps by capacity budget, cursor only moves forward.

    Each beat carries ``min_gap`` (process-cursor floor). Beats are placed earliest-first
    into positive-capacity gaps, consuming a proportional capacity token so wider gaps
    absorb more beats. The write cursor never rewinds — later process beats cannot land
    in an earlier gap than earlier beats (list-order == process-order). Zero-capacity
    (same-ms concurrent tool) gaps are skipped whenever a later positive gap exists.
    """
    n_gaps = len(capacities)
    buckets: list[list[tuple[str, str]]] = [[] for _ in range(n_gaps)]
    if not beats or n_gaps == 0:
        return buckets

    total_cap = sum(max(0, int(c)) for c in capacities)
    if total_cap <= 0:
        buckets[-1].extend((ch, part) for _, ch, part in beats)
        return buckets

    token = total_cap / len(beats)
    budget = [float(max(0, int(c))) for c in capacities]
    cursor = 0  # earliest gap still writable; monotonic forward

    for min_g, ch, part in beats:
        min_g = max(0, min(int(min_g), n_gaps - 1))
        start = max(cursor, min_g)
        pick: int | None = None
        for g in range(start, n_gaps):
            if capacities[g] <= 0:
                continue
            if budget[g] > 0:
                pick = g
                break
        if pick is None:
            # Budgets exhausted from start — overflow into last positive-capacity gap.
            for g in range(n_gaps - 1, start - 1, -1):
                if capacities[g] > 0:
                    pick = g
                    break
            if pick is None:
                pick = start
        buckets[pick].append((ch, part))
        budget[pick] -= token
        cursor = pick
    return buckets


def _inject_worker_run_deltas(
    events: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    *,
    chunk_size: int,
    chunk_gap_ms: int,
) -> list[dict[str, Any]]:
    """Rebuild ``run_output_delta`` / ``run_reasoning_delta`` inside each agent run window.

    Text beats fill the run's tool-anchored gaps by **capacity proportion** (not
    per-tool hard flush). Process order sets each beat's earliest gap; overflow may
    slide into later wider gaps so zero-width concurrent tool anchors never clump
    hundreds of beats onto one millisecond while the final tool→completed window
    stays empty.

    Concurrent debate runs interleave in the event list — started/completed indices
    are re-resolved before every inject so a prior insert cannot leave a stale hi
    anchor pointing at a foreign delta (negative-capacity gap → one-ms clump).
    """
    finals = _message_finals_by_run(rows)
    processes = _run_process_steps_by_run(rows)
    agent_ids = _agent_run_ids(events)
    if not finals or not agent_ids:
        return events

    remaining = set(agent_ids) & set(finals)
    while remaining:
        windows_now: list[tuple[str, int, int]] = []
        for i, ev in enumerate(events):
            if ev["kind"] != "run_started":
                continue
            p = ev.get("payload") or {}
            run_id = str(p.get("run_id") or "")
            if run_id not in remaining:
                continue
            completed = next(
                (
                    j
                    for j in range(i + 1, len(events))
                    if events[j]["kind"]
                    in ("run_completed", "run_failed", "run_cancelled")
                    and str((events[j].get("payload") or {}).get("run_id") or "")
                    == run_id
                ),
                None,
            )
            if completed is None:
                remaining.discard(run_id)
                continue
            windows_now.append((run_id, i, completed))
        if not windows_now:
            break

        # Highest completed index first — inserts below it leave earlier windows intact
        # for the next re-scan; still re-scan because concurrent peers may interleave.
        run_id, started_i, completed_i = max(windows_now, key=lambda w: w[2])
        remaining.discard(run_id)

        agent_id = agent_ids.get(run_id) or ""
        final = finals[run_id]
        segs = _run_text_segments(
            processes.get(run_id) or [],
            final_content=final["content"],
            final_reasoning=final["reasoning"],
        )
        if not segs:
            continue

        tool_starts: list[tuple[int, str]] = []
        for j in range(started_i + 1, completed_i):
            if events[j]["kind"] != "tool_use_start":
                continue
            p = events[j].get("payload") or {}
            if str(p.get("run_id") or "") != run_id:
                continue
            tool_starts.append((j, str(p.get("tool_name") or p.get("name") or "")))

        anchor_idxs = [started_i] + [t[0] for t in tool_starts] + [completed_i]
        gap_metas: list[tuple[int, int, int, int]] = []
        capacities: list[int] = []
        for a in range(len(anchor_idxs) - 1):
            lo_i = anchor_idxs[a]
            hi_i = anchor_idxs[a + 1]
            lo_ms = int(events[lo_i]["t_ms"])
            hi_ms = int(events[hi_i]["t_ms"])
            gap_metas.append((lo_i, hi_i, lo_ms, hi_ms))
            capacities.append(max(0, hi_ms - lo_ms))

        beats: list[tuple[int, str, str]] = []
        min_gap = 0
        tool_cursor = 0
        for ch, text in segs:
            if ch == "tool":
                matched = None
                for k in range(tool_cursor, len(tool_starts)):
                    if not text or tool_starts[k][1] == text or not tool_starts[k][1]:
                        matched = k
                        break
                if matched is None and tool_cursor < len(tool_starts):
                    matched = tool_cursor
                if matched is not None:
                    tool_cursor = matched + 1
                    min_gap = matched + 1
                continue
            for part in chunk_text(text, size=chunk_size):
                beats.append((min_gap, ch, part))

        if not beats:
            continue

        buckets = _assign_beats_to_gaps(beats, capacities)
        batch: list[tuple[int, list[dict[str, Any]]]] = []
        last_gap = len(gap_metas) - 1
        for gap_i, bucket in enumerate(buckets):
            if not bucket:
                continue
            _lo_i, hi_i, lo_ms, hi_ms = gap_metas[gap_i]
            times = _spread_times(
                lo_ms=lo_ms,
                hi_ms=hi_ms,
                n_parts=len(bucket),
                prefer_gap_ms=chunk_gap_ms if hi_ms <= lo_ms else None,
                align_end=(gap_i == last_gap),
            )
            bundled: list[dict[str, Any]] = []
            for (ch, part), t in zip(bucket, times, strict=True):
                kind = (
                    "run_reasoning_delta" if ch == "reasoning" else "run_output_delta"
                )
                bundled.append(
                    {
                        "kind": kind,
                        "payload": {
                            "run_id": run_id,
                            "agent_id": agent_id,
                            "delta": part,
                        },
                        "ts": None,
                        "t_ms": t,
                    }
                )
            batch.append((hi_i, bundled))

        for hi_i, bundled in sorted(batch, key=lambda x: x[0], reverse=True):
            if not bundled:
                continue
            events[hi_i:hi_i] = bundled

    return events


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
