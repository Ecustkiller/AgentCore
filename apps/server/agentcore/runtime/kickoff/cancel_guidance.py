"""开工卡（team_preview）取消后回灌 CEO 的软引导文案。

仅引导、不硬闸：wire 仍 ``decision=stop``；不自动再弹 ask。
ask_user 取消 / plan_review 取消下游不走本模块。
"""

from __future__ import annotations

from typing import Literal

# Soft guidance shared by delegate + debate kickoff cancel tool results.
KICKOFF_CANCEL_GUIDANCE = (
    "宜先问用户方案或分工哪里要调，再行动；"
    "勿未问清就重派同一套 / 再调 debate。"
)

_DELEGATE_HEAD = "用户取消了开工，团队未启动。"
_DEBATE_HEAD = "用户取消了辩论，未开赛。"


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
