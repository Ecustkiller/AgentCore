#!/usr/bin/env python3
"""Q8: draft quality cases from a log_patrol --json / snapshot file.

Writes status=open / verdict=undecided cards. Never copies
first_user_preview / last_user_preview (or their values) into any field.
Never invents production IDs — only ids already present on the snapshot
family bags are copied.

Usage (repo root):
  python evals/quality-cases/draft_from_patrol.py --snapshot path.json
  python evals/quality-cases/draft_from_patrol.py --snapshot - < snapshot.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from lint_cases import DATE_RE, ID_RE, TRACE_RE, UUID_RE, lint_document

ROOT = Path(__file__).resolve().parent
DEFAULT_OUT = ROOT / "cases"
PREVIEW_KEYS = frozenset({"first_user_preview", "last_user_preview"})
UNKNOWN_FAMILY = "unknown_or_new"
SIGNAL_TIERS = frozenset({"production", "dogfood", "L1_synthetic"})


class DraftError(Exception):
    pass


def _nonempty_str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _ids_from_bag(bag: Any, *, kind: str) -> list[str]:
    if not isinstance(bag, dict):
        return []
    raw = bag.get("ids")
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        text = _nonempty_str(item)
        if not text or text in seen:
            continue
        if kind == "trace" and not TRACE_RE.match(text):
            continue
        if kind == "conversation" and not UUID_RE.match(text):
            continue
        seen.add(text)
        out.append(text)
    return out


def _window_label(snapshot: dict[str, Any]) -> str:
    window = snapshot.get("window") if isinstance(snapshot.get("window"), dict) else {}
    since = window.get("since") or window.get("first_event_at")
    until = window.get("until") or window.get("last_event_at")

    def day(value: Any) -> str | None:
        if isinstance(value, str) and len(value) >= 10 and DATE_RE.match(value[:10]):
            return value[:10]
        return None

    start, end = day(since), day(until)
    if start and end:
        return f"{start}..{end}"
    label = _nonempty_str(window.get("label"))
    return label or "unknown-window"


def _opened_at(snapshot: dict[str, Any]) -> str:
    generated = snapshot.get("generated_at")
    if isinstance(generated, str) and len(generated) >= 10 and DATE_RE.match(generated[:10]):
        return generated[:10]
    window = _window_label(snapshot)
    match = re.match(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})", window)
    if match:
        return match.group(1)
    return datetime.now(UTC).strftime("%Y-%m-%d")


def _slug_for_family(key: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", key.lower()).strip("-")
    return slug or "family"


def _collect_previews(snapshot: dict[str, Any]) -> set[str]:
    previews: set[str] = set()
    rows = snapshot.get("conversations")
    if not isinstance(rows, list):
        return previews
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in PREVIEW_KEYS:
            text = _nonempty_str(row.get(key))
            if text:
                previews.add(text)
    return previews


def _walk_strings(obj: Any) -> list[str]:
    found: list[str] = []
    if isinstance(obj, str):
        found.append(obj)
    elif isinstance(obj, dict):
        for key, val in obj.items():
            found.append(str(key))
            found.extend(_walk_strings(val))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(_walk_strings(item))
    return found


def _assert_no_preview_leak(card: dict[str, Any], previews: set[str]) -> None:
    for text in _walk_strings(card):
        if text in PREVIEW_KEYS:
            raise DraftError("refusing to write snapshot preview field names into a case")
        stripped = text.strip()
        if stripped and stripped in previews:
            raise DraftError("refusing to copy user preview text into a case field")


def empty_open_case(
    *,
    case_id: str,
    opened_at: str,
    symptom: str,
    family: str | None,
    family_candidate: str | None,
    traces: list[str],
    conversations: list[str],
    window: str,
    n: int,
    signal_tier: str,
) -> dict[str, Any]:
    return {
        "schema_version": 1,
        "id": case_id,
        "opened_at": opened_at,
        "opened_by": "patrol",
        "symptom": symptom,
        "family": family,
        "family_candidate": family_candidate,
        "suspected_knobs": [],
        "knobs_changed": [],
        "evidence": {
            "traces": list(traces),
            "conversations": list(conversations),
            "occurrence_log": [{"window": window, "n": n}],
            "signal_tier": signal_tier,
            "repro_tier": None,
        },
        "verdict": "undecided",
        "verdict_note": "",
        "fix_class": None,
        "intercept_proposal": None,
        "disposition": {
            "eval_cases": [],
            "conformance_vectors": [],
            "dogfood_slots": [],
            "family_entry": None,
            "fix_commits": [],
        },
        "duplicate_of": None,
        "status": "open",
        "close_reason": None,
        "history": [],
    }


def draft_from_family(
    snapshot: dict[str, Any],
    family_key: str,
    family_row: dict[str, Any],
    *,
    signal_tier: str,
) -> dict[str, Any] | None:
    events = family_row.get("events")
    if type(events) is not int or isinstance(events, bool) or events <= 0:
        return None

    traces = _ids_from_bag(family_row.get("traces"), kind="trace")
    conversations = _ids_from_bag(family_row.get("conversations"), kind="conversation")
    if signal_tier == "production" and not traces and not conversations:
        return None

    opened_at = _opened_at(snapshot)
    ymd = opened_at.replace("-", "")
    if family_key == UNKNOWN_FAMILY:
        family: str | None = None
        family_candidate: str | None = UNKNOWN_FAMILY
        slug = "unknown-or-new"
    else:
        family = family_key
        family_candidate = None
        slug = _slug_for_family(family_key)

    case_id = f"qc-{ymd}-{slug}"
    if not ID_RE.match(case_id):
        raise DraftError(f"generated id is illegal: {case_id}")

    window = _window_label(snapshot)
    symptom = f"patrol 命中家族 {family_key}，本窗 {events} 次"
    card = empty_open_case(
        case_id=case_id,
        opened_at=opened_at,
        symptom=symptom,
        family=family,
        family_candidate=family_candidate,
        traces=traces,
        conversations=conversations,
        window=window,
        n=events,
        signal_tier=signal_tier,
    )
    _assert_no_preview_leak(card, _collect_previews(snapshot))
    return card


def draft_cases(
    snapshot: dict[str, Any],
    *,
    signal_tier: str,
    family: str | None = None,
) -> list[dict[str, Any]]:
    if not isinstance(snapshot, dict):
        raise DraftError("snapshot must be a JSON object")
    if snapshot.get("schema_version") != 1:
        raise DraftError("snapshot schema_version must be 1 (log_patrol --json)")
    families = snapshot.get("families")
    if not isinstance(families, dict):
        raise DraftError("snapshot missing families object")

    keys = [family] if family else sorted(families)
    cards: list[dict[str, Any]] = []
    for key in keys:
        row = families.get(key)
        if row is None:
            raise DraftError(f"family not in snapshot: {key}")
        if not isinstance(row, dict):
            continue
        card = draft_from_family(snapshot, key, row, signal_tier=signal_tier)
        if card is not None:
            cards.append(card)
    return cards


def load_snapshot(path: Path | None) -> dict[str, Any]:
    if path is None or str(path) == "-":
        raw = sys.stdin.read()
    else:
        if not path.is_file():
            raise DraftError(f"snapshot not found: {path}")
        raw = path.read_text(encoding="utf-8-sig")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DraftError(f"invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise DraftError("snapshot must be a JSON object")
    return data


def write_card(card: dict[str, Any], out_dir: Path, *, force: bool) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{card['id']}.json"
    if dest.exists() and not force:
        raise DraftError(f"already exists (pass --force to overwrite): {dest}")
    dest.write_text(
        json.dumps(card, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return dest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Draft open/undecided quality cases from a log_patrol snapshot. "
            "Does not invent IDs; does not copy user previews."
        )
    )
    parser.add_argument(
        "--snapshot",
        required=True,
        help="log_patrol --json / --snapshot-out file, or - for stdin",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT,
        help=f"directory for draft JSON (default: {DEFAULT_OUT})",
    )
    parser.add_argument("--family", help="draft only this family key")
    parser.add_argument(
        "--signal-tier",
        default="dogfood",
        choices=sorted(SIGNAL_TIERS),
        help="evidence.signal_tier (default dogfood; pass production for prod-export)",
    )
    parser.add_argument("--force", action="store_true", help="overwrite existing draft files")
    parser.add_argument("--dry-run", action="store_true", help="print cards; do not write")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        snapshot = load_snapshot(None if args.snapshot == "-" else Path(args.snapshot))
        cards = draft_cases(snapshot, signal_tier=args.signal_tier, family=args.family)
        if not cards:
            print(
                "OK: no draftable families (no events, or production without ids)",
                file=sys.stderr,
            )
            return 0

        written: list[str] = []
        for card in cards:
            hard = [f for f in lint_document(card, source=card["id"]) if f.level == "hard"]
            if hard:
                raise DraftError(hard[0].format())
            _assert_no_preview_leak(card, _collect_previews(snapshot))
            if args.dry_run:
                print(json.dumps(card, ensure_ascii=False, indent=2))
                continue
            dest = write_card(card, args.out_dir, force=args.force)
            written.append(str(dest))

        summary = {
            "drafts": [c["id"] for c in cards],
            "written": written,
            "dry_run": bool(args.dry_run),
            "signal_tier": args.signal_tier,
        }
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        return 0
    except (OSError, DraftError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
