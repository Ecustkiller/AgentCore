"""Force user-visible ask_user pause honesty (案 20260803-fake-dispatch-stall-claim · C).

Prompt (A) tells the model not to claim「已派/已开工」before ``delegate``. This module
is the pause-boundary backstop: card framing + bubble body must say the turn is
waiting for confirm, not silently empty / frozen on a kickoff claim.

Also ac890 ⑥B: forbid stacking「装完了/依赖就绪」with「尚未真正开工」on the same
pause face (append-always used to produce that contradiction).

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

# Closed set for install/deps-ready progress claims that contradict「尚未真正开工」.
# Do not expand with case-surface synonyms; new miss → revisit pause honesty, not词表堆叠.
_INSTALL_OR_DEPS_READY_CLAIM = re.compile(
    r"(?:"
    r"依赖(?:已经|已)?(?:装完|安装完成|装好|就绪)|"
    r"(?:环境|依赖)(?:已经|已)?就绪|"
    r"(?:已经|已)(?:装完|安装完成|装好)|"
    r"装完了|"
    r"安装(?:已经|已)?完成"
    r")"
)


def claims_dispatch_started(content: str) -> bool:
    """True when prose claims workers are already dispatched / underway."""
    text = (content or "").strip()
    if not text:
        return False
    return bool(_DISPATCH_STARTED_CLAIM.search(text))


def claims_install_or_deps_ready(content: str) -> bool:
    """True when prose claims install/deps already finished or ready."""
    text = (content or "").strip()
    if not text:
        return False
    return bool(_INSTALL_OR_DEPS_READY_CLAIM.search(text))


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
    # ac890 ⑥B: keep 装完/就绪 off the pause card (禁与「尚未开工」并列).
    if claims_install_or_deps_ready(text):
        return "请先确认，确认后再派工。"
    if _already_wait_confirm(text):
        return text
    if claims_dispatch_started(text) or is_process_dispatch_preamble(text):
        return f"先确认再派（尚未真正开工）：\n{text}"
    return text


def ensure_ask_user_pause_body(content: str) -> str:
    """After absorb: bubble must surface wait-confirm (forbid silent empty / kickoff).

    - Empty → fill the constant alone (204dcfda：禁 reply_chars=0).
    - 「装完了/依赖就绪」类 → **replace** with wait-confirm alone (ac890 ⑥B：禁与
      「尚未真正开工」叠写；勿 append 保留完成断言).
    - Already has wait-confirm phrasing → keep.
    - Any other user-visible prose → **append** the constant; never wholesale-replace
      (32b78c65：整替会掩盖短问 / 卡面原意).
    """
    text = (content or "").strip()
    if not text:
        return ASK_USER_PAUSE_USER_VISIBLE
    if claims_install_or_deps_ready(text):
        return ASK_USER_PAUSE_USER_VISIBLE
    if _already_wait_confirm(text):
        return text
    return f"{text}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
