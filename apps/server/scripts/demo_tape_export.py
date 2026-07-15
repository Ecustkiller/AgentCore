"""Export a turn_journal row set into demos/tapes/*.json.

From apps/server::

    uv run python scripts/demo_tape_export.py \\
        --message-id 3654bda5-e84b-4d41-a75c-092f454bf012 \\
        --out ../../demos/tapes/lv-molihua-trademark.json
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from agentcore.db.base import async_session_factory
from agentcore.demo_tape.export import build_tape_document, write_tape


async def _load(message_id: str) -> tuple[list[dict], dict]:
    async with async_session_factory() as s:
        rows = (
            await s.execute(
                text(
                    """
                    SELECT seq, kind, payload, ts, conversation_id, trace_id
                    FROM turn_journal
                    WHERE turn_id = :mid
                    ORDER BY seq
                    """
                ),
                {"mid": message_id},
            )
        ).mappings().all()
        if not rows:
            raise SystemExit(f"no turn_journal rows for message_id={message_id}")

        msg = (
            await s.execute(
                text(
                    """
                    SELECT id, conversation_id, content,
                           coalesce(reasoning_content, '') AS reasoning
                    FROM messages WHERE id = :mid
                    """
                ),
                {"mid": message_id},
            )
        ).mappings().one()

        user = (
            await s.execute(
                text(
                    """
                    SELECT content FROM messages
                    WHERE conversation_id = :cid AND role = 'user'
                      AND created_at <= (
                        SELECT created_at FROM messages WHERE id = :mid
                      )
                    ORDER BY created_at DESC
                    LIMIT 1
                    """
                ),
                {"cid": str(msg["conversation_id"]), "mid": message_id},
            )
        ).mappings().first()

        journal = [
            {
                "seq": r["seq"],
                "kind": r["kind"],
                "payload": r["payload"] or {},
                "ts": r["ts"],
            }
            for r in rows
        ]
        meta = {
            "source_message_id": message_id,
            "source_conversation_id": str(msg["conversation_id"]),
            "source_trace_id": rows[0]["trace_id"],
            "title": "LV诉茉莉奶白商标侵权案",
        }
        return journal, {
            "meta": meta,
            "captain_content": msg["content"] or "",
            "captain_reasoning": msg["reasoning"] or "",
            "user_prompt": (user["content"] if user else "") or "",
        }


async def _main(args: argparse.Namespace) -> None:
    rows, ctx = await _load(args.message_id)
    doc = build_tape_document(
        rows=rows,
        meta=ctx["meta"],
        captain_content=ctx["captain_content"],
        captain_reasoning=ctx["captain_reasoning"],
        user_prompt=ctx["user_prompt"],
        chunk_size=args.chunk_size,
        chunk_gap_ms=args.chunk_gap_ms,
    )
    out = Path(args.out)
    write_tape(out, doc)
    print(
        f"wrote {out} events={doc['meta']['event_count']} "
        f"duration_ms={doc['meta']['duration_ms']}"
    )


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--message-id", required=True)
    p.add_argument(
        "--out",
        default="../../demos/tapes/lv-molihua-trademark.json",
        help="Output tape path (relative to cwd)",
    )
    p.add_argument("--chunk-size", type=int, default=28)
    p.add_argument("--chunk-gap-ms", type=int, default=35)
    args = p.parse_args()
    asyncio.run(_main(args))


if __name__ == "__main__":
    main()
