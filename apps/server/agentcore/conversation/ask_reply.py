"""Return-path slot for a non-blocking ``question_posted`` (回程契约槽).

Outbound cards already carry ``ask_id``. This module is the inbound twin: an
optional identifier on a new-turn message / interjection / queue snapshot so the
CEO can tell which question the user answered — without scanning free text, and
without borrowing ``agent_mentions``. Absent / blank = ordinary message; still
digested.
"""

from __future__ import annotations

from typing import Any

# uuid4 with hyphens; padded so a future id format does not 422 honest clients.
ASK_ID_MAX = 64


def normalize_ask_id(raw: Any) -> str | None:
    """Strip and bound an inbound ``ask_id``. Empty / missing → ``None`` (ordinary message)."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if len(text) > ASK_ID_MAX:
        return None
    return text


def format_ask_reply_prompt(ask_id: str | None) -> str | None:
    """Structured hint that this user text answers a non-blocking ask.

    Omitted when there is no identifier so the turn stays byte-identical to today's
    ordinary message. Never guesses the question from free text.
    """
    aid = normalize_ask_id(ask_id)
    if not aid:
        return None
    return (
        f'<ask_reply ask_id="{aid}">\n'
        "用户本条消息是在回答该非阻塞提问（与出站 question_posted.ask_id 对应）。"
        "无本段则按普通消息处理。\n"
        "</ask_reply>"
    )
