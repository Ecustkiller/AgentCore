"""Debate-commitment parser: user picked a debate form on a settled ask_user.

Engine soft gate withdrawn — this module only classifies those answers.
"""

from __future__ import annotations

import re

from agentcore.llm.provider.protocol import LLMMessage

# Affirmative form labels seen on ask_user option labels + FORM_LABELS.
_FORM_AFFIRM = (
    "辩论（正反攻防）",
    "正反攻防",
    "正反辩论",
    "红队压测",
    "红队挑刺",
    "圆桌讨论",
    "多方圆桌",
)
# Explicit opt-out labels on the same question.
_FORM_DECLINE = (
    "不需要辩论环节",
    "不需要辩论",
    "无需辩论",
    "跳过辩论",
    "不要辩论",
)

# 「用户确认默认」is leftover inject on old transcripts; still a settled ask_user result.
_ASK_USER_SETTLED_PREFIXES = ("用户答复：", "用户选择：", "用户确认：", "用户确认默认：")
# 「辩论环节…：不需要辩论环节」style lines in the desktop-composed note.
_DECLINE_LINE_RE = re.compile(
    r"辩论[^\n：:]{0,24}[：:][^\n]{0,40}(?:" + "|".join(re.escape(d) for d in _FORM_DECLINE) + r")"
)
_AFFIRM_LINE_RE = re.compile(
    r"辩论[^\n：:]{0,24}[：:][^\n]{0,40}(?:"
    + "|".join(re.escape(a) for a in _FORM_AFFIRM)
    + r")"
)


def _is_ask_user_settled(text: str) -> bool:
    return any(text.startswith(p) for p in _ASK_USER_SETTLED_PREFIXES)


def _text_selects_debate_form(text: str) -> bool | None:
    """True / False when the settled ask_user prose clearly picks a debate form.

    ``None`` = no debate-form signal in this text.
    """
    if _DECLINE_LINE_RE.search(text):
        return False
    if _AFFIRM_LINE_RE.search(text):
        return True
    # Compact picks:「用户选择：辩论（正反攻防）」without the question prompt.
    if any(d in text for d in _FORM_DECLINE) and not any(a in text for a in _FORM_AFFIRM):
        return False
    if any(a in text for a in _FORM_AFFIRM):
        return True
    return None


def user_selected_debate_form(messages: list[LLMMessage]) -> bool:
    """True when a settled ask_user result prose committed to a debate form.

    Reads the composed tool-result (desktop picks). Bare confirm / empty continue
    is not a debate pick — tendency markup on the card is advice, not a selection.
    """
    for msg in messages:
        if msg.role == "tool" and msg.content and _is_ask_user_settled(msg.content):
            decided = _text_selects_debate_form(msg.content)
            if decided is not None:
                return decided
    return False
