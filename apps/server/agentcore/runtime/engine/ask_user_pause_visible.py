"""Force user-visible ask_user pause honesty (案 20260803-fake-dispatch-stall-claim · C).

Prompt (A) tells the model not to claim「已派/已开工」before ``delegate``. This module
is the pause-boundary backstop: card framing + bubble body must say the turn is
waiting for confirm, not silently empty / frozen on a kickoff claim.

Also ac890 ⑥B: forbid stacking「装完了/依赖就绪」with「尚未真正开工」on the same
pause face (append-always used to produce that contradiction).

午后巡 d4d5 / 53f08：空模板不得冲掉上轮已有结构化确认/选项；卡上有 default/选项时
pause 脸须能复述（同族 ask-empty-continue，不新发明硬闸）。

Deliberately not a soft-banner gate on free-form closing (that was option B — skipped).
"""

from __future__ import annotations

import re
from typing import Any

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


def is_hollow_ask_pause(content: str) -> bool:
    """True when body is empty or exactly the wait-confirm constant (d4d5 / 53f08)."""
    text = (content or "").strip()
    return (not text) or text == ASK_USER_PAUSE_USER_VISIBLE


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


def structured_confirm_restatement(
    questions: list[dict[str, Any]] | None = None,
    assumptions: list[dict[str, Any]] | None = None,
) -> str:
    """Build a short user-visible restatement of card defaults / options / paths.

    Shared with empty-continue inject（``result.confirmed_defaults_summary`` family）so
    pause face and resume inject stay on one axis — no new hard gate.
    """
    from agentcore.tools.builtin.ask_user.result import (
        confirmed_defaults_summary,
        structured_options_summary,
    )

    defaults = confirmed_defaults_summary(questions, assumptions)
    if defaults:
        return f"确认默认：{defaults}"
    options = structured_options_summary(questions)
    if options:
        return f"可选：{options}"
    return ""


def ensure_ask_user_pause_body(
    content: str,
    *,
    questions: list[dict[str, Any]] | None = None,
    assumptions: list[dict[str, Any]] | None = None,
    prior_visible: str | None = None,
) -> str:
    """After absorb: bubble must surface wait-confirm (forbid silent empty / kickoff).

    - Empty / hollow-only → fill the constant alone (204dcfda：禁 reply_chars=0)，
      **unless** card defaults/options or ``prior_visible`` structured confirm can be
      restated（d4d5 / 53f08：禁空模板冲掉上轮选项）.
    - 「装完了/依赖就绪」类 → **replace** with wait-confirm alone (ac890 ⑥B：禁与
      「尚未真正开工」叠写；勿 append 保留完成断言).
    - Already has wait-confirm phrasing → keep (unless hollow-only + restatement).
    - Any other user-visible prose → **append** the constant; never wholesale-replace
      (32b78c65：整替会掩盖短问 / 卡面原意).
    """
    text = (content or "").strip()
    restatement = structured_confirm_restatement(questions, assumptions)
    prior = (prior_visible or "").strip()
    prior_usable = bool(prior) and not is_hollow_ask_pause(prior)

    if is_hollow_ask_pause(text):
        if restatement:
            return f"{restatement}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
        if prior_usable:
            if _already_wait_confirm(prior):
                return prior
            return f"{prior}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
        return ASK_USER_PAUSE_USER_VISIBLE

    if claims_install_or_deps_ready(text):
        if restatement:
            return f"{restatement}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
        return ASK_USER_PAUSE_USER_VISIBLE
    if _already_wait_confirm(text):
        return text
    return f"{text}\n\n{ASK_USER_PAUSE_USER_VISIBLE}"
