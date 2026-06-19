"""Conversation export serializers (导出对话: Markdown + JSON).

Turns a conversation's full transcript into a downloadable artifact. Two formats:

- **Markdown** — a clean, human-readable Q&A record: user / assistant turns with
  their text, web sources as links, and attachment names. Deliberately content-only
  (no reasoning / cost / tool internals) — the document a user would actually read
  or paste elsewhere.
- **JSON** — full message fidelity for power users / re-import: every persisted
  field of the user/assistant rows (content, reasoning, citations, attachments,
  usage snapshot, finish_reason, timestamps), minus internal-only ids.

The route reads the whole transcript (``MessageRepository.list_all_for_conversation``)
and hands it here; these functions are pure (no DB / IO), so they unit-test directly.
Spend is never exported — it lives in the cost ledger, not the message body.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

from agentcore.db.models import Conversation, Message

# Only conversational turns are exported; system / tool-shaped rows (no human-facing
# body) are skipped so the artifact reads as a clean dialogue.
_EXPORTED_ROLES = ("user", "assistant")

_ROLE_LABELS = {"user": "用户", "assistant": "AgentCore"}


def _visible_messages(messages: Sequence[Message]) -> list[Message]:
    """User/assistant turns that carry text, in render order.

    A row with no content (e.g. an interrupted assistant turn that only produced
    tool calls) would render as an empty section, so it is dropped — export shows
    what the user can read.
    """
    return [
        m
        for m in messages
        if m.role in _EXPORTED_ROLES and (m.content or "").strip()
    ]


def _fmt_ts(value: datetime | None) -> str:
    """Human-readable minute-precision timestamp for the Markdown header."""
    if value is None:
        return ""
    return value.strftime("%Y-%m-%d %H:%M")


def conversation_to_markdown(
    conversation: Conversation, messages: Sequence[Message]
) -> str:
    """Render a conversation as a clean Markdown transcript (the default export).

    Each turn becomes a ``##`` section headed by its author and time, followed by
    the message text. Web sources (citations) and attachment names are appended per
    turn as small reference lists when present.
    """
    title = (conversation.title or "").strip() or "未命名对话"
    lines: list[str] = [f"# {title}", ""]
    lines.append(f"> 由 AgentCore 导出 · {_fmt_ts(datetime.now(UTC))} UTC")
    lines.append("")

    for msg in _visible_messages(messages):
        label = _ROLE_LABELS.get(msg.role, msg.role)
        ts = _fmt_ts(msg.created_at)
        heading = f"## {label}" + (f" · {ts}" if ts else "")
        lines.append(heading)
        lines.append("")
        lines.append((msg.content or "").strip())
        lines.append("")

        citations = msg.citations or []
        if citations:
            lines.append("**来源**")
            lines.append("")
            for c in citations:
                if not isinstance(c, dict):
                    continue
                url = str(c.get("url") or "").strip()
                if not url:
                    continue
                name = str(c.get("title") or c.get("site") or url).strip()
                lines.append(f"- [{name}]({url})")
            lines.append("")

        attachments = msg.attachments or []
        names = [
            str(a.get("name") or a.get("path") or "").strip()
            for a in attachments
            if isinstance(a, dict)
        ]
        names = [n for n in names if n]
        if names:
            lines.append("**附件**：" + "、".join(names))
            lines.append("")

    # Collapse the trailing blank line into a single terminal newline.
    return "\n".join(lines).rstrip() + "\n"


def conversation_to_json(
    conversation: Conversation, messages: Sequence[Message]
) -> dict:
    """Render a conversation as a full-fidelity JSON document (power-user export).

    Carries every human-meaningful field of the user/assistant rows so the export
    round-trips far more faithfully than Markdown. Internal-only ids (trace_id, the
    row/conversation UUIDs beyond the conversation id) are kept minimal; spend is
    intentionally absent (it lives in the cost ledger).
    """
    return {
        "conversation_id": conversation.id,
        "title": (conversation.title or "").strip() or "未命名对话",
        "exported_at": datetime.now(UTC).isoformat(),
        "messages": [
            {
                "role": m.role,
                "content": m.content,
                "reasoning_content": m.reasoning_content,
                "citations": m.citations or [],
                "attachments": m.attachments or [],
                "usage": m.usage,
                "finish_reason": m.finish_reason,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in messages
            if m.role in _EXPORTED_ROLES
        ],
    }
