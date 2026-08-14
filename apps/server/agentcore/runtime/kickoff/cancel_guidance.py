"""开工卡（team_preview）取消 / 超时后回灌 CEO 的软引导文案。

仅引导、不硬闸：wire 仍 ``decision=stop`` / ``timeout``；不自动再弹 ask。
ask_user 取消的拒答引导在 ``tools/builtin/ask_user/result.py``（同形 CONTINUE 回灌）；
超时文案对齐 ask timeout（未回应 + 自行收尾），不套用取消的「宜先问」。
plan_review 取消 / 超时下游不走本模块。
"""

from __future__ import annotations

from typing import Literal

# Soft guidance shared by delegate + debate kickoff cancel tool results.
# 末句是接着拒答时的出口：本引导让 CEO 追问一次，若那一问也被取消，再问就是纠缠。
KICKOFF_CANCEL_GUIDANCE = (
    "宜先问用户方案或分工哪里要调，再行动；"
    "勿未问清就重派同一套 / 再调 debate。"
    "若用户接着拒答这一问，就直接收口，别再追问。"
)

# Timeout is not a refuse: do not reuse the cancel「宜先问」ask-first line.
KICKOFF_TIMEOUT_GUIDANCE = (
    "请基于目前已掌握的信息自行收尾；"
    "禁止未获确认就重派同一套 / 再调 debate。"
)

_DELEGATE_HEAD = "用户取消了开工，团队未启动。"
_DEBATE_HEAD = "用户取消了辩论，未开赛。"
_DELEGATE_TIMEOUT_HEAD = "用户未在时限内回应，团队未启动。"
_DEBATE_TIMEOUT_HEAD = "用户未在时限内回应，辩论未开赛。"


def format_kickoff_cancel_result(
    *,
    primitive: Literal["delegate", "debate"] = "delegate",
    note: str = "",
) -> str:
    """CEO-facing tool result after team_preview STOP (delegate or debate).

    User ``note`` (if any) is included; guidance always stays so the CEO still
    asks before re-dispatching / re-opening debate.
    """
    head = _DEBATE_HEAD if primitive == "debate" else _DELEGATE_HEAD
    note_text = (note or "").strip()
    if note_text:
        return f"{head}用户留言：{note_text}\n{KICKOFF_CANCEL_GUIDANCE}"
    return f"{head}\n{KICKOFF_CANCEL_GUIDANCE}"


def format_kickoff_timeout_result(
    *,
    primitive: Literal["delegate", "debate"] = "delegate",
    note: str = "",
) -> str:
    """CEO-facing tool result after team_preview TIMEOUT (delegate or debate).

    Aligns with ask timeout: no response in time, team/debate never started,
    CEO wraps up; do not re-dispatch the same set without confirmation.
    """
    head = _DEBATE_TIMEOUT_HEAD if primitive == "debate" else _DELEGATE_TIMEOUT_HEAD
    note_text = (note or "").strip()
    if note_text:
        return f"{head}用户留言：{note_text}\n{KICKOFF_TIMEOUT_GUIDANCE}"
    return f"{head}\n{KICKOFF_TIMEOUT_GUIDANCE}"
