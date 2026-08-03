"""Force user-visible ask_user pause honesty (案 20260803-fake-dispatch-stall-claim · C).

Prompt (A) tells the model not to claim「已派/已开工」before ``delegate``. This module
is the pause-boundary backstop: card framing + bubble body must say the turn is
waiting for confirm, not silently empty / frozen on a kickoff claim.

Deliberately not a soft-banner gate on free-form closing (that was option B — skipped).
"""

from __future__ import annotations

import re

from agentcore.runtime.closing_posture import is_process_dispatch_preamble

ASK_USER_PAUSE_USER_VISIBLE = "等待确认后再派工；此前尚未真正开工。"

_DISPATCH_STARTED_CLAIM = re.compile(
    r"(?:"
    r"已(?:成功)?(?:派出|派工|开工)|"
    r"已派\s*\d|"
    r"派(?:出)?\s*\d+\s*个\s*(?:worker|队员|人)\s*开工|"
    r"队员已在(?:做|干|开工)|"
    r"现在开工|"
    r"开工高规格"
    r")"
)


def claims_dispatch_started(content: str) -> bool:
    """True when prose claims workers are already dispatched / underway."""
    text = (content or "").strip()
    if not text:
        return False
    return bool(_DISPATCH_STARTED_CLAIM.search(text))


def _already_wait_confirm(text: str) -> bool:
    return any(
        m in text
        for m in ("等待确认", "先确认再派", "确认后再派", "尚未派工", "尚未真正开工")
    )


def honest_ask_user_message(message: str) -> str:
    """Card ``message`` must not read as already-dispatched while pausing to ask."""
    text = (message or "").strip()
    if not text:
        return "请先确认，确认后再派工。"
    if _already_wait_confirm(text):
        return text
    if claims_dispatch_started(text) or is_process_dispatch_preamble(text):
        return f"先确认再派（尚未真正开工）：\n{text}"
    return text


def ensure_ask_user_pause_body(content: str) -> str:
    """After absorb: bubble must surface wait-confirm (forbid silent empty / kickoff)."""
    text = (content or "").strip()
    if _already_wait_confirm(text):
        return text
    if not text or is_process_dispatch_preamble(text) or claims_dispatch_started(text):
        return ASK_USER_PAUSE_USER_VISIBLE
    return f"{text}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
