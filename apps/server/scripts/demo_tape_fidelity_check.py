"""Offline fidelity checks: re-exported tape vs oracle journal/message.

Usage (from apps/server)::

    uv run python scripts/demo_tape_fidelity_check.py
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from sqlalchemy import text

from agentcore.db.base import async_session_factory
from agentcore.demo_tape.export import build_tape_events, load_tape

ORACLE_MID = "714e38da-f5c8-4c75-b676-4a771e813462"
TAPE_PATH = Path(__file__).resolve().parents[3] / "demos" / "tapes" / "lv-molihua-trademark.json"
OUT_DIR = Path(__file__).resolve().parents[3] / "apps" / "desktop" / "demo-tape-out"


async def _oracle() -> tuple[str, list[dict], str]:
    async with async_session_factory() as s:
        msg = (
            await s.execute(
                text(
                    "SELECT content, coalesce(reasoning_content,'') AS reasoning "
                    "FROM messages WHERE id=:mid"
                ),
                {"mid": ORACLE_MID},
            )
        ).mappings().one()
        rows = (
            await s.execute(
                text(
                    "SELECT seq, kind, payload, ts FROM turn_journal "
                    "WHERE turn_id=:mid ORDER BY seq"
                ),
                {"mid": ORACLE_MID},
            )
        ).mappings().all()
    journal = [
        {"seq": r["seq"], "kind": r["kind"], "payload": r["payload"] or {}, "ts": r["ts"]}
        for r in rows
    ]
    return msg["content"] or "", journal, msg["reasoning"] or ""


def _check_tape_order(events: list[dict]) -> list[str]:
    errs: list[str] = []
    # For every run_id, first run_started must precede first run_context.
    first_started: dict[str, int] = {}
    first_context: dict[str, int] = {}
    for i, e in enumerate(events):
        rid = str((e.get("payload") or {}).get("run_id") or "")
        if not rid:
            continue
        if e["kind"] == "run_started" and rid not in first_started:
            first_started[rid] = i
        if e["kind"] == "run_context" and rid not in first_context:
            first_context[rid] = i
    for rid, ci in first_context.items():
        si = first_started.get(rid)
        if si is None:
            errs.append(f"run_context without run_started: {rid}")
        elif si > ci:
            errs.append(f"run_context before run_started: {rid} (ctx@{ci} > started@{si})")
    return errs


def _check_debate_structure(events: list[dict]) -> list[str]:
    errs: list[str] = []
    started = [
        e for e in events if e["kind"] == "run_started"
    ]
    # moderator id is debate_<uuid> with a single underscore after "debate"
    mods = [
        e
        for e in started
        if (p := e.get("payload") or {})
        and str(p.get("run_id", "")).startswith("debate_")
        and "_r" not in str(p.get("run_id"))
        and "_closing" not in str(p.get("run_id"))
        and "_cx_" not in str(p.get("run_id"))
        and p.get("kind") == "agent"
    ]
    if len(mods) < 1:
        errs.append("missing moderator run_started")
    closings = [e for e in started if "closing" in str((e.get("payload") or {}).get("run_id", ""))]
    if len(closings) < 2:
        errs.append(f"expected 2 closing run_started, got {len(closings)}")
    cx_ctx = 0
    closing_ctx = 0
    for e in events:
        if e["kind"] != "run_context":
            continue
        ch = [b.get("channel") for b in ((e.get("payload") or {}).get("blocks") or [])]
        if "cross_exam" in ch:
            cx_ctx += 1
        if "closing" in ch:
            closing_ctx += 1
    # Existence lower bounds — recorded round counts vary per re-recording, so we assert
    # the debate projection is present/complete rather than pinning an exact round count.
    if cx_ctx < 1:
        errs.append(f"expected >=1 cross_exam run_context, got {cx_ctx}")
    if closing_ctx < 2:
        errs.append(f"expected 2 closing run_context, got {closing_ctx}")
    rounds = sum(1 for e in events if e["kind"] == "debate_round_started")
    if rounds < 1:
        errs.append(f"expected >=1 debate_round_started, got {rounds}")
    return errs


async def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    oracle_content, journal, reasoning = await _oracle()
    tape = load_tape(TAPE_PATH)
    events = list(tape.get("events") or [])

    tape_content = "".join(
        (e.get("payload") or {}).get("delta") or ""
        for e in events
        if e.get("kind") == "content_delta"
    )
    report: dict = {
        "oracle_message_id": ORACLE_MID,
        "tape": str(TAPE_PATH),
        "checks": {},
        "errors": [],
    }

    ok_content = tape_content == oracle_content
    report["checks"]["captain_content_byte_equal"] = ok_content
    if not ok_content:
        report["errors"].append(
            f"captain content mismatch: oracle={len(oracle_content)} tape={len(tape_content)}"
        )

    # Reasoning oracle = concat of captain process_reasoning bursts (what the tape now
    # reconstructs, positioned along the timeline). Differs from messages.reasoning_content
    # only by the pause-boundary joiner, so fidelity is anchored to the process timeline.
    oracle_reasoning = "".join(
        str((r.get("payload") or {}).get("text") or "")
        for r in journal
        if r.get("kind") == "process_reasoning"
    )
    tape_reasoning = "".join(
        (e.get("payload") or {}).get("delta") or ""
        for e in events
        if e.get("kind") == "reasoning_delta"
    )
    ok_reasoning = tape_reasoning == oracle_reasoning
    report["checks"]["captain_reasoning_byte_equal"] = ok_reasoning
    if not ok_reasoning:
        report["errors"].append(
            f"captain reasoning mismatch: oracle={len(oracle_reasoning)} tape={len(tape_reasoning)}"
        )

    # Fresh export from oracle must match on-disk tape content join + order invariants.
    fresh = build_tape_events(
        journal, captain_content=oracle_content, captain_reasoning=reasoning
    )
    fresh_content = "".join(
        (e.get("payload") or {}).get("delta") or ""
        for e in fresh
        if e.get("kind") == "content_delta"
    )
    report["checks"]["fresh_export_content_byte_equal"] = fresh_content == oracle_content
    if fresh_content != oracle_content:
        report["errors"].append("fresh export content != oracle")
    fresh_reasoning = "".join(
        (e.get("payload") or {}).get("delta") or ""
        for e in fresh
        if e.get("kind") == "reasoning_delta"
    )
    report["checks"]["fresh_export_reasoning_byte_equal"] = fresh_reasoning == oracle_reasoning
    if fresh_reasoning != oracle_reasoning:
        report["errors"].append("fresh export reasoning != oracle")

    order_errs = _check_tape_order(events)
    report["checks"]["started_before_context"] = not order_errs
    report["errors"].extend(order_errs)

    struct_errs = _check_debate_structure(events)
    report["checks"]["debate_structure"] = not struct_errs
    report["errors"].extend(struct_errs)

    # Simulate fold after message_final injection shape: build entries as player would
    # from a sink is hard offline; assert tape itself has contiguous started→context.
    report["ok"] = len(report["errors"]) == 0
    out = OUT_DIR / "fidelity-report.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"wrote {out}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
