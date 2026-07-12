"""Conversation timeline — merges DB messages + runtime log events into one view.

Run from apps/server:

    uv run python scripts/log_timeline.py <conversation_id>
    uv run python scripts/log_timeline.py --recent           # last 5 conversations
    uv run python scripts/log_timeline.py --trace <trace_id> # one interaction's
                                                             # full log chain
                                                             # (log-only: trace_id
                                                             # is not persisted)

    # Offline mode (production export, no DB):
    uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export --recent
    uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export <conv_id>
    uv run python scripts/log_timeline.py --export-dir ../../logs/prod-export --trace <trace_id>

    # Custom event log file:
    uv run python scripts/log_timeline.py --file ../../logs/prod-export/events.jsonl <conv_id>

Message bodies live in Postgres (conversations / messages); the per-turn run trace
(chat.turn_start/complete, delegate, tool, errors) lives in logs/dev.jsonl. This
joins them by conversation_id, or follows a single interaction by trace_id.

Each delegated worker's react/tool events are nested into an indented block under
its identity (agent_id · depth) so one delegation's reasoning chain reads
top-to-bottom; the CEO/captain loop stays on the chronological spine and brackets
the workers it delegates to. See .cursor/rules/conversation-logs.mdc.
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
            text("SELECT id, title, agent_id, created_at FROM conversations WHERE id = :cid"),
            {"cid": conv_id},
        )
    ).first()
    if not row:
        return None
    return {"id": row[0], "title": row[1], "agent_id": row[2], "created_at": str(row[3])}


async def fetch_messages(conn: Any, conv_id: str) -> list[dict]:
    from sqlalchemy import text

    # messages schema (db/models/conversations.Message): no tool_calls /
    # finish_reason columns — those live in turn_journal when present.
    rows = (
        await conn.execute(
            text(
                "SELECT id, role, content, reasoning_content, usage, created_at "
                "FROM messages WHERE conversation_id = :cid ORDER BY created_at"
            ),
            {"cid": conv_id},
        )
    ).all()
    # The turn's replay payload moved out of messages.runs into the turn_journal
    # table (§18.3 唯一事实源); count its facts per turn (== assistant message id).
    journal_counts: dict[str, int] = {}
    for jr in (
        await conn.execute(
            text(
                "SELECT turn_id, count(*) FROM turn_journal "
                "WHERE conversation_id = :cid GROUP BY turn_id"
            ),
            {"cid": conv_id},
        )
    ).all():
        journal_counts[jr[0]] = jr[1]
    messages = []
    for r in rows:
        msg: dict[str, Any] = {
            "type": "message",
            "timestamp": str(r[5]),
            "id": r[0],
            "role": r[1],
            "content_preview": (r[2] or "")[:200],
            "content_len": len(r[2] or ""),
            "has_reasoning": bool(r[3]),
            "tool_calls_count": 0,
            "runs_count": journal_counts.get(r[0], 0),
            "finish_reason": None,
        }
        if r[4]:
            msg["usage"] = r[4]
        messages.append(msg)
    return messages


_LOG_NOISE_KEYS = ("type", "timestamp", "event", "level", "logger", "request_id", "method", "path")


def load_log_events(
    value: str, field: str = "conversation_id", log_file: Path = LOG_FILE
) -> list[dict]:
    """Load log lines whose ``field`` equals ``value`` (conversation_id or trace_id)."""
    if not log_file.exists():
        return []
    events = []
    with open(log_file, encoding="utf-8") as f:
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


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def _load_export_conversations(export_dir: Path) -> list[dict]:
    """Load conversations from an export directory."""
    return _read_jsonl(export_dir / "conversations.jsonl")


def _find_in_export(export_dir: Path, conv_id: str) -> dict | None:
    for conv in _load_export_conversations(export_dir):
        if str(conv.get("id")) == conv_id:
            return {
                "id": str(conv["id"]),
                "title": conv.get("title"),
                "agent_id": conv.get("agent_id"),
                "created_at": str(conv.get("created_at", "")),
            }
    return None


def _load_export_messages(export_dir: Path, conv_id: str) -> list[dict]:
    """Load messages for a conversation from an export directory."""
    journal_counts: dict[str, int] = {}
    for entry in _read_jsonl(export_dir / "turn_journal.jsonl"):
        if str(entry.get("conversation_id")) != conv_id:
            continue
        turn_id = str(entry.get("turn_id", ""))
        journal_counts[turn_id] = journal_counts.get(turn_id, 0) + 1

    messages: list[dict] = []
    for row in _read_jsonl(export_dir / "messages.jsonl"):
        if str(row.get("conversation_id")) != conv_id:
            continue
        content = row.get("content") or ""
        tool_calls = row.get("tool_calls")
        msg_id = str(row.get("id", ""))
        msg: dict[str, Any] = {
            "type": "message",
            "timestamp": str(row.get("created_at", "")),
            "id": msg_id,
            "role": row.get("role"),
            "content_preview": content[:200],
            "content_len": len(content),
            "has_reasoning": bool(row.get("reasoning_content")),
            "tool_calls_count": len(tool_calls) if tool_calls else 0,
            "runs_count": journal_counts.get(msg_id, 0),
            "finish_reason": row.get("finish_reason"),
        }
        if row.get("usage"):
            msg["usage"] = row["usage"]
        messages.append(msg)
    messages.sort(key=lambda x: x.get("timestamp", ""))
    return messages


def _parse_cli_args(argv: list[str]) -> tuple[Path, Path | None, list[str]]:
    log_file = LOG_FILE
    export_dir: Path | None = None
    positional: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--file" and i + 1 < len(argv):
            log_file = Path(argv[i + 1])
            i += 2
        elif arg == "--export-dir" and i + 1 < len(argv):
            export_dir = Path(argv[i + 1])
            i += 2
        else:
            positional.append(arg)
            i += 1
    return log_file, export_dir, positional


def _fmt_log_line(item: dict, indent: str = "  ", hide: tuple[str, ...] = ()) -> str:
    ts = item.get("timestamp", "")[:19]
    event = item.get("event", "?")
    icon = {"error": "[E]", "warning": "[W]"}.get(item.get("level", ""), "   ")
    skip = ("type", "timestamp", "event", "level", *hide)
    detail_keys = {k: v for k, v in item.items() if k not in skip}
    detail = " ".join(f"{k}={v}" for k, v in detail_keys.items())
    if len(detail) > 120:
        detail = detail[:120] + "..."
    return f"{indent}{ts}  {icon} {event}  {detail}"


def _format_delegate_plan_dag(item: dict, indent: str = "      ") -> list[str]:
    """ASCII DAG for delegate.started when plan + waves are present (new logs)."""
    plan = item.get("plan")
    waves = item.get("waves")
    if not plan or not waves:
        return []

    id_to_role: dict[str, str] = {}
    id_to_deps: dict[str, list[str]] = {}
    for node in plan:
        nid = node.get("id", "?")
        id_to_role[nid] = node.get("role") or nid
        id_to_deps[nid] = node.get("depends_on") or []

    lines: list[str] = []
    for wave_idx, wave in enumerate(waves):
        if wave_idx == 0:
            label = "Wave 0 (独立):"
        elif wave_idx == 1:
            label = "Wave 1 (依赖 Wave 0):"
        else:
            label = f"Wave {wave_idx}:"
        lines.append(f"{indent}├── {label}")
        for node_id in wave:
            role = id_to_role.get(node_id, node_id)
            deps = id_to_deps.get(node_id, [])
            if deps:
                dep_roles = ", ".join(id_to_role.get(d, d) for d in deps)
                lines.append(f"{indent}│     {role} ({node_id}) ← {dep_roles}")
            else:
                lines.append(f"{indent}│     {role} ({node_id})")
    return lines


def _fmt_log_item(item: dict, indent: str = "  ", hide: tuple[str, ...] = ()) -> list[str]:
    """One log event line, plus optional delegate plan DAG."""
    dag_hide: tuple[str, ...] = ()
    if item.get("event") == "delegate.started" and item.get("plan") and item.get("waves"):
        dag_hide = ("plan", "waves")
    lines = [_fmt_log_line(item, indent=indent, hide=(*hide, *dag_hide))]
    if dag_hide:
        lines.extend(_format_delegate_plan_dag(item, indent=indent + "    "))
    return lines


# react.* / tool.* events carry a delegated worker's identity (run_id/agent_id/
# depth), bound in runtime/runs/executor.py. We nest them into a per-worker block
# so one delegation's reasoning chain reads top-to-bottom instead of interleaving
# with other concurrent workers. CEO/captain events have no depth and stay on the
# chronological spine — they bracket the workers they delegate to.
_WORKER_EVENT_PREFIXES = ("react.", "tool.")
_WORKER_REDUNDANT_KEYS = ("agent_id", "run_id", "depth", "trace_id")


def _worker_key(item: dict) -> tuple[str, str] | None:
    """Grouping key for a delegated-worker log event, or None to keep it on the spine."""
    if item.get("type") != "log":
        return None
    if not item.get("event", "").startswith(_WORKER_EVENT_PREFIXES):
        return None
    depth = item.get("depth")
    if not depth:  # CEO/captain loop has no depth -> stays on the spine
        return None
    # trace_id separates turns in a full-conversation view; it is absent (filtered)
    # in --trace mode where every event already shares one trace.
    return (item.get("trace_id", ""), item.get("run_id") or item.get("agent_id") or "?")


def _partition_worker_groups(log_events: list[dict]) -> list[dict]:
    """Pull delegated-worker react/tool events into per-worker group blocks.

    Returns spine events plus synthetic ``worker_group`` items, each positioned at
    its worker's earliest event so the block renders where the delegation began.
    """
    spine: list[dict] = []
    groups: dict[tuple[str, str], dict] = {}
    for ev in log_events:
        key = _worker_key(ev)
        if key is None:
            spine.append(ev)
            continue
        grp = groups.get(key)
        if grp is None:
            grp = {
                "type": "worker_group",
                "agent_id": ev.get("agent_id") or ev.get("run_id") or "?",
                "depth": ev.get("depth") or 1,
                "timestamp": ev.get("timestamp", ""),
                "events": [],
            }
            groups[key] = grp
        grp["events"].append(ev)
        ts = ev.get("timestamp", "")
        if ts and (not grp["timestamp"] or ts < grp["timestamp"]):
            grp["timestamp"] = ts
    for grp in groups.values():
        grp["events"].sort(key=lambda x: x.get("timestamp", ""))
    return spine + list(groups.values())


def _fmt_worker_group(grp: dict) -> list[str]:
    depth = grp.get("depth", 1)
    agent = grp.get("agent_id", "?")
    rounds = sum(1 for e in grp["events"] if e.get("event") == "react.round_end")
    tools = sum(1 for e in grp["events"] if e.get("event") == "tool.execute_end")
    meta = [f"d{depth}"]
    if rounds:
        meta.append(f"{rounds} round{'s' if rounds != 1 else ''}")
    if tools:
        meta.append(f"{tools} tool{'s' if tools != 1 else ''}")
    pad = "  " + "    " * depth
    child_indent = pad + "│  "
    lines = [f"{pad}┌─ worker {agent}  ({' · '.join(meta)})"]
    for ev in grp["events"]:
        lines.extend(_fmt_log_item(ev, indent=child_indent, hide=_WORKER_REDUNDANT_KEYS))
    return lines


_TURN_SPINE_EVENTS = frozenset({"chat.turn_start", "chat.turn_complete"})


def load_conversation_spine_events(conversation_id: str, log_file: Path = LOG_FILE) -> list[dict]:
    """Load chat.turn_start / chat.turn_complete events for a conversation."""
    if not log_file.exists():
        return []
    events: list[dict] = []
    with open(log_file, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("conversation_id") != conversation_id:
                continue
            event = obj.get("event", "")
            if event not in _TURN_SPINE_EVENTS:
                continue
            events.append(
                {
                    "timestamp": obj.get("timestamp", ""),
                    "event": event,
                    "trace_id": obj.get("trace_id", ""),
                    "preview": obj.get("preview", ""),
                    "delegated": obj.get("delegated"),
                }
            )
    return events


def _extract_conversation_id(log_events: list[dict]) -> str | None:
    for item in log_events:
        cid = item.get("conversation_id")
        if cid:
            return str(cid)
    return None


def _summarize_turn_preview(preview: str, max_len: int = 60) -> str:
    text = (preview or "").replace("\n", " ").strip()
    if not text:
        return "(no preview)"
    if len(text) > max_len:
        return text[: max_len - 3] + "..."
    return text


def format_conversation_context(
    conversation_id: str, spine_events: list[dict], current_trace_id: str
) -> str:
    """One-line-per-turn summary of a conversation, highlighting *current_trace_id*."""
    by_trace: dict[str, dict[str, Any]] = {}
    for ev in spine_events:
        tid = ev.get("trace_id") or ""
        if not tid:
            continue
        slot = by_trace.setdefault(tid, {"trace_id": tid})
        if ev["event"] == "chat.turn_start":
            slot["start"] = ev
        elif ev["event"] == "chat.turn_complete":
            slot["complete"] = ev

    turns = sorted(
        by_trace.values(),
        key=lambda t: (t.get("start") or t.get("complete") or {}).get("timestamp", ""),
    )
    if not turns:
        return ""

    lines = [
        "",
        "─" * 70,
        f"  对话上下文  (conversation_id: {conversation_id})",
        f"  回合: {len(turns)}",
        "─" * 70,
    ]
    for turn in turns:
        tid = turn["trace_id"]
        start = turn.get("start")
        complete = turn.get("complete")
        ts = ((start or complete) or {}).get("timestamp", "")[:19]
        preview = _summarize_turn_preview((start or {}).get("preview", ""))
        is_current = tid == current_trace_id
        marker = ">>> " if is_current else "    "
        current_tag = " [当前]" if is_current else ""

        if complete:
            status = "✓"
            extras: list[str] = []
            if complete.get("delegated"):
                extras.append("委派")
            status_suffix = f"  {' · '.join(extras)}" if extras else ""
        elif start:
            status = "⚠️ 未完成"
            status_suffix = ""
        else:
            status = "?"
            status_suffix = ""

        lines.append(f"{marker}{ts}{current_tag}  \"{preview}\"  {status}{status_suffix}")
        if is_current:
            lines.append(f"    trace_id: {tid}")
    lines.append("")
    return "\n".join(lines)


def format_trace(trace_id: str, log_events: list[dict], log_file: Path = LOG_FILE) -> str:
    lines = [
        "=" * 70,
        f"  Trace: {trace_id}",
        f"  Log events: {len(log_events)}",
        "=" * 70,
    ]
    items = _partition_worker_groups(log_events)
    for item in sorted(items, key=lambda x: x.get("timestamp", "")):
        if item["type"] == "worker_group":
            lines += _fmt_worker_group(item)
        else:
            lines.extend(_fmt_log_item(item))
    lines.append("")
    output = "\n".join(lines)
    conv_id = _extract_conversation_id(log_events)
    if conv_id:
        spine = load_conversation_spine_events(conv_id, log_file=log_file)
        output += format_conversation_context(conv_id, spine, trace_id)
    return output


def format_timeline(conv: dict, messages: list[dict], log_events: list[dict]) -> str:
    lines = [
        "=" * 70,
        f"  Conversation: {conv.get('title', '(untitled)')}",
        f"  ID: {conv['id']}",
        f"  Agent: {conv.get('agent_id', '?')}  |  Created: {conv.get('created_at', '?')}",
        f"  Messages: {len(messages)}  |  Log events: {len(log_events)}",
        "=" * 70,
    ]
    items = messages + _partition_worker_groups(log_events)
    for item in sorted(items, key=lambda x: x.get("timestamp", "")):
        if item["type"] == "worker_group":
            lines += _fmt_worker_group(item)
        elif item["type"] == "message":
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
            lines.extend(_fmt_log_item(item))
    lines.append("")
    return "\n".join(lines)


async def list_recent(n: int = 5, export_dir: Path | None = None) -> None:
    if export_dir:
        rows = sorted(
            _load_export_conversations(export_dir),
            key=lambda c: str(c.get("created_at", "")),
            reverse=True,
        )[:n]
        print(f"\n  Recent {len(rows)} conversations:\n")
        for r in rows:
            print(
                f"  {str(r.get('created_at', ''))[:19]}  {r.get('id')}  {r.get('title') or '(untitled)'}"
            )
        print()
        return

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
    log_file, export_dir, args = _parse_cli_args(sys.argv[1:])
    if export_dir:
        log_file = export_dir / "events.jsonl"

    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return
    if args[0] == "--recent":
        await list_recent(int(args[1]) if len(args) > 1 else 5, export_dir=export_dir)
        return
    if args[0] == "--trace":
        if len(args) < 2:
            print("usage: log_timeline.py --trace <trace_id>")
            return
        print(format_trace(args[1], load_log_events(args[1], field="trace_id", log_file=log_file), log_file=log_file))
        return

    conv_id = args[0]
    if export_dir:
        conv = _find_in_export(export_dir, conv_id)
        if not conv:
            print(f"Conversation '{conv_id}' not found in export.")
            return
        messages = _load_export_messages(export_dir, conv_id)
        log_events = load_log_events(conv_id, log_file=log_file)
        print(format_timeline(conv, messages, log_events))
        return

    engine = _create_engine()
    async with engine.connect() as conn:
        conv = await fetch_conversation(conn, conv_id)
        if not conv:
            print(f"Conversation '{conv_id}' not found.")
            await engine.dispose()
            return
        messages = await fetch_messages(conn, conv_id)
    log_events = load_log_events(conv_id, log_file=log_file)
    print(format_timeline(conv, messages, log_events))
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
