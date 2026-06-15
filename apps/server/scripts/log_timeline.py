"""Conversation timeline — merges DB messages + runtime log events into one view.

Run from apps/server:

    uv run python scripts/log_timeline.py <conversation_id>
    uv run python scripts/log_timeline.py --recent           # last 5 conversations
    uv run python scripts/log_timeline.py --trace <trace_id> # one interaction's
                                                             # full log chain
                                                             # (log-only: trace_id
                                                             # is not persisted)

Message bodies live in Postgres (conversations / messages); the per-turn run trace
(chat.turn_start/complete, delegate, tool, errors) lives in logs/dev.jsonl. This
joins them by conversation_id, or follows a single interaction by trace_id.
See .cursor/rules/conversation-logs.mdc.
"""

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

# scripts/ -> server -> apps -> <repo root>
_REPO_ROOT = Path(__file__).resolve().parents[3]
LOG_FILE = _REPO_ROOT / "logs" / "dev.jsonl"
# Make the agentcore package importable when run as a bare script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _create_engine():
    from sqlalchemy.ext.asyncio import create_async_engine

    from agentcore.config import settings

    return create_async_engine(settings.database_url, pool_size=2, max_overflow=0)


async def fetch_conversation(conn: Any, conv_id: str) -> dict | None:
    from sqlalchemy import text

    row = (
        await conn.execute(
            text(
                "SELECT id, title, agent_id, created_at FROM conversations "
                "WHERE id = :cid"
            ),
            {"cid": conv_id},
        )
    ).first()
    if not row:
        return None
    return {"id": row[0], "title": row[1], "agent_id": row[2], "created_at": str(row[3])}


async def fetch_messages(conn: Any, conv_id: str) -> list[dict]:
    from sqlalchemy import text

    rows = (
        await conn.execute(
            text(
                "SELECT id, role, content, reasoning_content, tool_calls, runs, "
                "usage, finish_reason, created_at FROM messages "
                "WHERE conversation_id = :cid ORDER BY created_at"
            ),
            {"cid": conv_id},
        )
    ).all()
    messages = []
    for r in rows:
        msg: dict[str, Any] = {
            "type": "message",
            "timestamp": str(r[8]),
            "id": r[0],
            "role": r[1],
            "content_preview": (r[2] or "")[:200],
            "content_len": len(r[2] or ""),
            "has_reasoning": bool(r[3]),
            "tool_calls_count": len(r[4]) if r[4] else 0,
            "runs_count": len((r[5] or {}).get("events", [])) if r[5] else 0,
            "finish_reason": r[7],
        }
        if r[6]:
            msg["usage"] = r[6]
        messages.append(msg)
    return messages


_LOG_NOISE_KEYS = ("type", "timestamp", "event", "level", "logger", "request_id", "method", "path")


def load_log_events(value: str, field: str = "conversation_id") -> list[dict]:
    """Load log lines whose ``field`` equals ``value`` (conversation_id or trace_id)."""
    if not LOG_FILE.exists():
        return []
    events = []
    with open(LOG_FILE, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get(field) == value:
                events.append(
                    {
                        "type": "log",
                        "timestamp": obj.get("timestamp", ""),
                        "event": obj.get("event", ""),
                        "level": obj.get("level", ""),
                        **{k: v for k, v in obj.items() if k not in _LOG_NOISE_KEYS and k != field},
                    }
                )
    return events


def _fmt_log_line(item: dict) -> str:
    ts = item.get("timestamp", "")[:19]
    event = item.get("event", "?")
    icon = {"error": "[E]", "warning": "[W]"}.get(item.get("level", ""), "   ")
    detail_keys = {k: v for k, v in item.items() if k not in ("type", "timestamp", "event", "level")}
    detail = " ".join(f"{k}={v}" for k, v in detail_keys.items())
    if len(detail) > 120:
        detail = detail[:120] + "..."
    return f"  {ts}  {icon} {event}  {detail}"


def format_trace(trace_id: str, log_events: list[dict]) -> str:
    lines = [
        "=" * 70,
        f"  Trace: {trace_id}",
        f"  Log events: {len(log_events)}",
        "=" * 70,
    ]
    log_events.sort(key=lambda x: x.get("timestamp", ""))
    lines += [_fmt_log_line(it) for it in log_events]
    lines.append("")
    return "\n".join(lines)


def format_timeline(conv: dict, messages: list[dict], log_events: list[dict]) -> str:
    lines = [
        "=" * 70,
        f"  Conversation: {conv.get('title', '(untitled)')}",
        f"  ID: {conv['id']}",
        f"  Agent: {conv.get('agent_id', '?')}  |  Created: {conv.get('created_at', '?')}",
        f"  Messages: {len(messages)}  |  Log events: {len(log_events)}",
        "=" * 70,
    ]
    for item in sorted(messages + log_events, key=lambda x: x.get("timestamp", "")):
        if item["type"] == "message":
            role = item["role"]
            icon = {"user": "[user]", "assistant": "[asst]", "system": "[sys ]"}.get(role, "[?]")
            preview = item["content_preview"].replace("\n", " ")
            line = f"  {item['timestamp'][:19]}  {icon} {preview}"
            if item["content_len"] > 200:
                line += f"... ({item['content_len']} chars)"
            extras = []
            if item["tool_calls_count"]:
                extras.append(f"tools:{item['tool_calls_count']}")
            if item["runs_count"]:
                extras.append(f"runs:{item['runs_count']}")
            if item["finish_reason"]:
                extras.append(f"finish:{item['finish_reason']}")
            if extras:
                line += f"  [{', '.join(extras)}]"
            lines.append(line)
        else:
            lines.append(_fmt_log_line(item))
    lines.append("")
    return "\n".join(lines)


async def list_recent(n: int = 5) -> None:
    from sqlalchemy import text

    engine = _create_engine()
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT id, title, created_at FROM conversations "
                    "WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT :n"
                ),
                {"n": n},
            )
        ).all()
    print(f"\n  Recent {len(rows)} conversations:\n")
    for r in rows:
        print(f"  {str(r[2])[:19]}  {r[0]}  {r[1] or '(untitled)'}")
    print()
    await engine.dispose()


async def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    if args[0] == "--recent":
        await list_recent(int(args[1]) if len(args) > 1 else 5)
        return
    if args[0] == "--trace":
        if len(args) < 2:
            print("usage: log_timeline.py --trace <trace_id>")
            return
        print(format_trace(args[1], load_log_events(args[1], field="trace_id")))
        return

    conv_id = args[0]
    engine = _create_engine()
    async with engine.connect() as conn:
        conv = await fetch_conversation(conn, conv_id)
        if not conv:
            print(f"Conversation '{conv_id}' not found.")
            await engine.dispose()
            return
        messages = await fetch_messages(conn, conv_id)
    log_events = load_log_events(conv_id)
    print(format_timeline(conv, messages, log_events))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
