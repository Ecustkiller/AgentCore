"""Export a live-stream recording into demos/tapes/*.json.

The journal-reconstruction exporter is retired — tapes are cut from recordings.
Record the run first (``DEMO_TAPE_RECORD_ENABLED=true`` in apps/server/.env →
``demos/recordings/<message_id>.json``), then, from apps/server::

    uv run python scripts/demo_tape_export.py \\
        --message-id <assistant message id> \\
        --title "我的演示" \\
        --out ../../demos/tapes/my-demo.json

``--user-prompt`` overrides the DB lookup of the triggering user message (needed
when exporting on a box without the source conversation).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from agentcore.db.base import async_session_factory
from agentcore.demo_tape.export import (
    TapeExportRefusedError,
    build_tape_from_recording,
    write_tape,
)
from agentcore.demo_tape.recorder import load_recording, recording_path
from agentcore.demo_tape.sanitize import IngestScanError


async def _lookup_user_prompt(conversation_id: str, message_id: str) -> str:
    """The user message that triggered the recorded turn (best-effort)."""
    try:
        async with async_session_factory() as s:
            row = (
                await s.execute(
                    text(
                        """
                        SELECT content FROM messages
                        WHERE conversation_id = :cid AND role = 'user'
                          AND created_at <= coalesce(
                            (SELECT created_at FROM messages WHERE id = :mid), now()
                          )
                        ORDER BY created_at DESC
                        LIMIT 1
                        """
                    ),
                    {"cid": conversation_id, "mid": message_id},
                )
            ).mappings().first()
        return str(row["content"]) if row and row["content"] else ""
    except Exception as e:  # noqa: BLE001 — DB is optional here; --user-prompt covers it
        print(f"warn: user-prompt DB lookup failed ({e}); pass --user-prompt")
        return ""


async def _main(args: argparse.Namespace) -> None:
    rec_path = Path(args.recording) if args.recording else recording_path(args.message_id)
    if not rec_path.exists():
        raise SystemExit(
            f"recording not found: {rec_path}\n"
            "Record the run first: set DEMO_TAPE_RECORD_ENABLED=true, restart the "
            "backend, run the turn, then re-export."
        )
    recording = load_recording(rec_path)
    rec_meta = recording.get("meta") or {}
    conversation_id = str(rec_meta.get("conversation_id") or "")
    message_id = str(rec_meta.get("message_id") or args.message_id or "")

    user_prompt = args.user_prompt or ""
    if not user_prompt and conversation_id:
        user_prompt = await _lookup_user_prompt(conversation_id, message_id)
    if not user_prompt:
        raise SystemExit("no user prompt (DB lookup empty) — pass --user-prompt")

    tape_meta: dict = {"title": args.title or Path(args.out).stem}
    if args.followups:
        tape_meta["followups"] = list(args.followups)
    try:
        doc = build_tape_from_recording(
            recording,
            meta=tape_meta,
            user_prompt=user_prompt,
            force=bool(args.force),
        )
    except (TapeExportRefusedError, IngestScanError) as e:
        raise SystemExit(str(e)) from e
    out = Path(args.out)
    write_tape(out, doc)
    chips = doc["meta"].get("followups") or []
    print(
        f"wrote {out} events={doc['meta']['event_count']} "
        f"duration_ms={doc['meta']['duration_ms']} "
        f"followups={len(chips)}"
    )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--message-id", help="Assistant message id (locates the recording)")
    p.add_argument(
        "--recording",
        help="Explicit recording file path (overrides --message-id lookup)",
    )
    p.add_argument("--title", default="", help="Tape title (command palette entry)")
    p.add_argument("--user-prompt", default="", help="Override the DB user-prompt lookup")
    p.add_argument(
        "--followups",
        nargs="+",
        default=None,
        help="Override meta.followups (otherwise lifted from recorded followups_generated)",
    )
    p.add_argument("--out", required=True, help="Output tape path (relative to cwd)")
    p.add_argument(
        "--force",
        action="store_true",
        help=(
            "Override export refusal for unwired pause kinds "
            "(checkpoint_required / plan_review_required) and approval_* events. "
            "Does not bypass client-tool assertion or ingest memory/PII scan."
        ),
    )
    args = p.parse_args()
    if not args.message_id and not args.recording:
        raise SystemExit("provide --message-id or --recording")
    asyncio.run(_main(args))


if __name__ == "__main__":
    main()
