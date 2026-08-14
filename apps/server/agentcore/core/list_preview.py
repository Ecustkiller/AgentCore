"""Sidebar list preview: last visible assistant sentence (never a user turn).

Leaf helper — ``db`` and ``conversation`` both consume this. Writers do not
store a conversations column: a later empty stop / running placeholder must
not freeze a stale sentence, and housekeeping must not invent one.

Interrupt face strings are copied from ``runtime.turn.interrupt`` so this
module stays a leaf (``core`` cannot import ``runtime``). Keep them identical.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agentcore.core.message_merge import MESSAGE_STATUS_RUNNING

# Align with desktop ``PREVIEW_SLICE`` / ConversationItem ``PREVIEW_MAX_CHARS``.
PREVIEW_MAX_CHARS = 80

# SQL window after dropping empty / chrome-only rows. Walk-back still applies
# inside this window (running placeholders with leaked text, leftover suffix).
PREVIEW_SQL_LOOKBACK = 24

# Must match ``runtime.turn.interrupt`` (copied — core cannot import runtime).
_INTERRUPTED_EMPTY_USER_VISIBLE = (
    "【中断说明】本轮意外中断，未产出回复。可直接发送下一条继续。"
)
_REDRIVE_FAILED_USER_VISIBLE = (
    "【中断说明】服务中断后没能接着把这一轮跑完——队员都已停下，这一轮不会再有新进展。"
    "已经写进工作区的文件、以及上面已经产出的内容都还在。"
    "直接发下一条就能继续，也可以让我接着没做完的部分往下做。"
)

# Historical interrupt body chrome (writers stopped appending these). Same strings
# as ``memory.consolidation`` — kept here so list projection does not import that
# module. Exact match or leftover-empty after strip ⇒ not a visible assistant sentence.
_INCOMPLETE_NOTE = (
    "（已停止，本回合未完成。下面是已完成队员的产出，已为你保留；如需继续，可重新发送消息。）"
)
_INCOMPLETE_SUFFIX = "（已停止，本回合未完成——以上为已生成部分；如需继续，可重新发送消息。）"
_INCOMPLETE_NOTE_LEGACY = (
    "（连接中断，本回合未完成。下面是已完成队员的产出，已为你保留；如需继续，可重新发送消息。）"
)
_INCOMPLETE_SUFFIX_LEGACY = (
    "（连接中断，本回合未完成——以上为已生成部分；如需继续，可重新发送消息。）"
)
_INTERRUPTED_NOTE_LEGACY = "（已中断，可重试）"
_DESKTOP_STOP_FACE = "已停止"

_CHROME_EXACT = frozenset(
    {
        _INTERRUPTED_EMPTY_USER_VISIBLE,
        _REDRIVE_FAILED_USER_VISIBLE,
        _INCOMPLETE_NOTE,
        _INCOMPLETE_NOTE_LEGACY,
        _INTERRUPTED_NOTE_LEGACY,
        _DESKTOP_STOP_FACE,
        "后台恢复失败",
    }
)
_CHROME_SUFFIXES = (
    _INCOMPLETE_SUFFIX,
    _INCOMPLETE_SUFFIX_LEGACY,
    _INTERRUPTED_NOTE_LEGACY,
    _REDRIVE_FAILED_USER_VISIBLE,
    _INTERRUPTED_EMPTY_USER_VISIBLE,
)

# Exact bodies the picker treats as invisible. SQL drops these so the lookback
# cap is not consumed by empty-stop chrome (walk-back still holds under truncation).
PREVIEW_CHROME_ONLY = frozenset({*_CHROME_EXACT, *_CHROME_SUFFIXES})


def _strip_interrupt_chrome(body: str) -> str:
    text = body.strip()
    if text in _CHROME_EXACT:
        return ""
    for suffix in _CHROME_SUFFIXES:
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
    if _REDRIVE_FAILED_USER_VISIBLE in text:
        text = text.replace(_REDRIVE_FAILED_USER_VISIBLE, "").strip()
    if _INTERRUPTED_EMPTY_USER_VISIBLE in text:
        text = text.replace(_INTERRUPTED_EMPTY_USER_VISIBLE, "").strip()
    return text


def assistant_preview_text(content: str | None, usage: Any | None) -> str | None:
    """Return a list-safe preview for one assistant row, or ``None`` to walk back.

    Skips empty, ``running`` placeholders, cancelled/incomplete without a body,
    and stop/interrupt chrome. A cancelled/incomplete row with real leftover
    text is visible and is kept. Never invents a failure face.
    """
    meta = usage if isinstance(usage, dict) else {}
    if meta.get("status") == MESSAGE_STATUS_RUNNING:
        return None
    raw = (content or "").strip()
    if not raw:
        return None
    cleaned = _strip_interrupt_chrome(raw)
    if not cleaned:
        return None
    normalized = " ".join(cleaned.split())
    return normalized[:PREVIEW_MAX_CHARS] or None


def pick_last_visible_assistant_preview(
    rows: Sequence[tuple[str | None, Any | None]],
) -> str | None:
    """Newest-first assistant ``(content, usage)`` rows → first visible preview.

    Callers must pass assistant rows only. No user-text fallback.
    """
    for content, usage in rows:
        preview = assistant_preview_text(content, usage)
        if preview:
            return preview
    return None
