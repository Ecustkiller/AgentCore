"""开工卡（team_preview）调整后回灌 CEO 的软引导文案。

与取消引导正交：取消会让 CEO 先问用户；调整要求按意见修订后重新提交
（再调 delegate / debate，经开工闸重新出卡）。不硬闸、不设轮次上限。
"""

from __future__ import annotations

from typing import Literal

KICKOFF_ADJUST_GUIDANCE_DELEGATE = (
    "请按用户意见修订方案后重新调用 delegate；"
    "修订后须再次经开工确认，未获确认不得开工。"
    "若某条意见做不到，必须在新方案里明说做不到及原因，禁止静默忽略。"
    "下一步是改方案并重新提交，而不是再问用户同一件事。"
)
KICKOFF_ADJUST_GUIDANCE_DEBATE = (
    "请按用户意见修订方案后重新调用 debate；"
    "修订后须再次经开赛确认，未获确认不得开赛。"
    "若某条意见做不到，必须在新方案里明说做不到及原因，禁止静默忽略。"
    "下一步是改方案并重新提交，而不是再问用户同一件事。"
)

_DELEGATE_HEAD = "用户要求调整开工方案，团队未启动。"
_DEBATE_HEAD = "用户要求调整开赛方案，辩论未开赛。"


def format_kickoff_adjust_result(
    *,
    primitive: Literal["delegate", "debate"] = "delegate",
    note: str = "",
) -> str:
    """CEO-facing tool result after team_preview ADJUST (delegate or debate).

    No grant / no start. User ``note`` (if any) is included; guidance always
    stays so the CEO revises and resubmits through the kickoff gate.
    """
    if primitive == "debate":
        head = _DEBATE_HEAD
        guidance = KICKOFF_ADJUST_GUIDANCE_DEBATE
    else:
        head = _DELEGATE_HEAD
        guidance = KICKOFF_ADJUST_GUIDANCE_DELEGATE
    note_text = (note or "").strip()
    if note_text:
        return f"{head}用户意见：{note_text}\n{guidance}"
    return f"{head}\n{guidance}"
