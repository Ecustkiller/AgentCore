"""Tape file io + recording → tape export (dev-only).

The journal-reconstruction export layer is retired (2026-07): tapes are cut straight
from live-stream recordings (``demo_tape/recorder.py``). The recorded stream already
carries true pacing and every EPHEMERAL liveliness event (typing deltas, composing
heartbeats, tool phases) that ``turn_journal`` never stored, so the former
window-filling / re-chunking / delta-rebuilding heuristics have no object left.

On-disk tape schema (v2)::

    {version: 2, meta, events[{type, payload, timestamp, t_ms}]}

Legacy v1 tapes (``kind``/``ts``, e.g. ``lv-molihua-trademark``) are read with
alias compatibility and never rewritten for format migration. Content governance
(sanitize) may rewrite event bodies in place while keeping the on-disk dialect.

Export gates (offline, before write):

- sanitize + ingest scan (shared with recording_cut) — memory / PII residue;
- refuse unwired pause kinds + ``approval_*`` (``--force`` escape hatch);
- assert no client-tool required kinds remain (cut-table defense-in-depth).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from agentcore.demo_tape.sanitize import sanitize_and_scan_events
from agentcore.demo_tape.schema import (
    CLIENT_TOOL_REQUIRED_KINDS,
    TAPE_EXCLUDED_KINDS,
    TAPE_FORMAT_VERSION,
    TAPE_UNWIRED_PAUSE_KINDS,
    event_type,
    normalize_tape_events,
)


class TapeExportRefusedError(ValueError):
    """Tape export refused by an offline gate (pause / approval / client-tool)."""

    def __init__(self, reasons: list[str]) -> None:
        self.reasons = reasons
        super().__init__(
            "tape export refused:\n  - " + "\n  - ".join(reasons)
            + "\nPass force=True / --force to override pause/approval gates only "
            "(client-tool + ingest scan remain hard)."
        )


def _followups_from_recording(recording: dict[str, Any]) -> list[str] | None:
    """Last non-empty ``followups_generated`` payload on the recording (if any).

    Chips do not enter the tape event stream (``TAPE_EXCLUDED_KINDS``); they ride
    ``meta.followups`` so replay can re-emit with the current turn's message_id.
    """
    found: list[str] | None = None
    for segment in recording.get("segments") or []:
        if not isinstance(segment, dict):
            continue
        for ev in segment.get("events") or []:
            if not isinstance(ev, dict):
                continue
            if event_type(ev) != "followups_generated":
                continue
            raw = (ev.get("payload") or {}).get("followups")
            if isinstance(raw, list) and raw:
                found = [str(x) for x in raw if str(x).strip()]
    return found or None


def collect_export_gate_reasons(events: list[dict[str, Any]]) -> list[str]:
    """Pause/approval + client-tool gate reasons (empty ⇒ pass).

    Pause/approval reasons are force-overrideable; client-tool reasons are not.
    """
    reasons: list[str] = []
    seen_pause: set[str] = set()
    seen_approval: set[str] = set()
    seen_client: set[str] = set()
    for ev in events:
        if not isinstance(ev, dict):
            continue
        et = event_type(ev)
        if not et:
            continue
        if et in TAPE_UNWIRED_PAUSE_KINDS and et not in seen_pause:
            seen_pause.add(et)
            reasons.append(
                f"unwired pause kind {et!r} — player only suspends team_preview; "
                "export refused (use --force to override)"
            )
        if et.startswith("approval_") and et not in seen_approval:
            seen_approval.add(et)
            reasons.append(
                f"approval event {et!r} — not wired for tape replay; "
                "export refused (use --force to override)"
            )
        if et in CLIENT_TOOL_REQUIRED_KINDS and et not in seen_client:
            seen_client.add(et)
            reasons.append(
                f"client-tool required {et!r} — must not ship on a tape "
                "(cut-table leak; not force-overrideable)"
            )
    return reasons


def assert_export_allowed(
    events: list[dict[str, Any]], *, force: bool = False
) -> None:
    """Raise :class:`TapeExportRefusedError` when export gates fire.

    ``force`` only bypasses unwired-pause / approval refusals. Client-tool
    presence always refuses (sanitize/scan is a separate hard gate).
    """
    reasons = collect_export_gate_reasons(events)
    if force:
        reasons = [r for r in reasons if "client-tool required" in r]
    if reasons:
        raise TapeExportRefusedError(reasons)


def build_tape_from_recording(
    recording: dict[str, Any],
    *,
    meta: dict[str, Any] | None = None,
    user_prompt: str = "",
    force: bool = False,
) -> dict[str, Any]:
    """Cut a live-stream recording into a playable tape document.

    Segments (send leg, then each resume leg) are stitched onto one global timeline
    using their wall-clock starts, so the human decision gap at a pause point stays a
    real gap on the tape — the player skips it on resume (prev_t=None → first beat
    immediate) exactly as with journal-era tapes. Event ``t_ms`` are otherwise the
    recorded wall-clock offsets: true pacing, no synthesis. Event types in
    :data:`~agentcore.demo_tape.schema.TAPE_EXCLUDED_KINDS` (turn lifecycle, recorded
    settlements, per-turn meta chrome, client-tool requests) are cut.

    After the cut: memory sanitize + ingest scan (shared with recording_cut), then
    export gates (unwired pause / approval / client-tool assertion).

    Recorded ``followups_generated`` chips are lifted into ``meta.followups`` (still
    cut from ``events``). Caller ``meta`` may override (e.g. ``--followups``).

    Accepts legacy recording events (``kind``/``ts``) via read-time alias; output
    always uses contract fields (``type``/``timestamp``) at
    :data:`~agentcore.demo_tape.schema.TAPE_FORMAT_VERSION`.
    """
    segments = list(recording.get("segments") or [])
    events: list[dict[str, Any]] = []
    base_wall: int | None = None
    last_t = 0
    for segment in segments:
        wall_t0 = segment.get("wall_t0_ms")
        if isinstance(wall_t0, int):
            if base_wall is None:
                base_wall = wall_t0
            offset = max(0, wall_t0 - base_wall)
        else:  # no wall clock on the segment — butt it against the previous one
            offset = last_t
        for ev in segment.get("events") or []:
            if not isinstance(ev, dict):
                continue
            et = event_type(ev)
            if not et or et in TAPE_EXCLUDED_KINDS:
                continue
            t_ms = offset + int(ev.get("t_ms") or 0)
            # Monotonic safety net: wall clocks and per-segment offsets never
            # legitimately rewind; clamp any jitter so pacing math stays simple.
            t_ms = max(t_ms, last_t)
            last_t = t_ms
            # Preserve explicit null from either dialect.
            if "timestamp" in ev:
                ts = ev.get("timestamp")
            elif "ts" in ev:
                ts = ev.get("ts")
            else:
                ts = None
            events.append(
                {
                    "type": et,
                    "payload": ev.get("payload") or {},
                    "timestamp": ts,
                    "t_ms": t_ms,
                }
            )

    events = sanitize_and_scan_events(events)
    assert_export_allowed(events, force=force)

    extracted_followups = _followups_from_recording(recording)
    doc_meta: dict[str, Any] = {
        "source_conversation_id": (recording.get("meta") or {}).get("conversation_id"),
        "source_message_id": (recording.get("meta") or {}).get("message_id"),
        **({"followups": extracted_followups} if extracted_followups else {}),
        **(meta or {}),
        "user_prompt": user_prompt,
        "duration_ms": int(events[-1]["t_ms"]) if events else 0,
        "event_count": len(events),
    }
    return {
        "version": TAPE_FORMAT_VERSION,
        "meta": doc_meta,
        "events": events,
    }


def write_tape(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_tape(path: Path) -> dict[str, Any]:
    """Load a tape; normalize event elements to ``type``/``timestamp`` in memory.

    Does not rewrite the on-disk file (legacy v1 ``kind``/``ts`` stays as stored).
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or "events" not in data:
        raise ValueError(f"invalid tape file: {path}")
    events = data.get("events") or []
    if not isinstance(events, list):
        raise ValueError(f"invalid tape events: {path}")
    return {**data, "events": normalize_tape_events(events)}
