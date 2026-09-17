"""形态 profile 三元组 —— 交互单元 + 轮内拓扑 + 收敛/产物语义。

把「轮内全员并行波」从引擎唯一形状降级为 DEBATE profile 的形状；红队 / 圆桌由既有
原语（并行委派 + continue_run + 材料注入）组合出星型三拍 / 点名串行。

→ 见 docs/03-AI核心/辩论编排设计.md（形态 profile；详细提案不在公开仓）
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from agentcore.runtime.debate.types import DebateConfig, DebateForm

InteractionUnit = Literal["side_turn", "finding", "thread_turn"]
PhaseName = Literal[
    "parallel_wave",
    "cross_exam",
    "attack",
    "merge",
    "defense",
    "rebuttal",
    "nominate_serial",
    "crux",
]


@dataclass(frozen=True)
class FormProfile:
    """一场辩论的形态 profile（提案 §3.1）。

    ``unit`` 交互单元；``phases`` 轮内拓扑（phase 名序）；``cross_exam`` / ``closing`` 是否
    走正反共用的主持人→各方质询 / 结辩原语。新场 ``closing`` 恒假（结辩 runner 留旧场回放）；
    ``has_rebuttal`` 红队三拍的复攻拍。
    """

    form: DebateForm
    unit: InteractionUnit
    phases: tuple[PhaseName, ...]
    cross_exam: bool
    closing: bool
    has_rebuttal: bool = False


def form_profile(config: DebateConfig) -> FormProfile:
    """由 ``DebateConfig`` 派生本场 profile（单一入口，门槛与 Moderator 闸同源）。"""
    if config.form is DebateForm.RED_TEAM:
        return FormProfile(
            form=DebateForm.RED_TEAM,
            unit="finding",
            phases=("attack", "merge", "defense", "rebuttal"),
            cross_exam=False,  # 三拍取代通用质询
            closing=False,  # O1：红队结辩移除
            has_rebuttal=True,
        )
    if config.form is DebateForm.ROUNDTABLE:
        return FormProfile(
            form=DebateForm.ROUNDTABLE,
            unit="thread_turn",
            phases=("nominate_serial", "crux"),
            cross_exam=False,
            closing=False,
            has_rebuttal=False,
        )
    return FormProfile(
        form=DebateForm.DEBATE,
        unit="side_turn",
        phases=("parallel_wave", "cross_exam"),
        cross_exam=True,
        closing=False,  # 新场不跑结辩；结辩 runner 留旧场回放
        has_rebuttal=False,
    )
