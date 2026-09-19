"""正反形态 profile —— 交互单元 + 轮内拓扑。

→ 见 docs/03-AI核心/辩论编排设计.md
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from agentcore.runtime.debate.types import DebateConfig, DebateForm

InteractionUnit = Literal["side_turn"]
PhaseName = Literal["parallel_wave", "cross_exam"]


@dataclass(frozen=True)
class FormProfile:
    """一场辩论的形态 profile。产品只开正反：并行波 + 质询。"""

    form: DebateForm
    unit: InteractionUnit
    phases: tuple[PhaseName, ...]
    cross_exam: bool
    closing: bool
    has_rebuttal: bool = False


def form_profile(config: DebateConfig) -> FormProfile:
    """由 ``DebateConfig`` 派生本场 profile。"""
    del config
    return FormProfile(
        form=DebateForm.DEBATE,
        unit="side_turn",
        phases=("parallel_wave", "cross_exam"),
        cross_exam=True,
        closing=False,
        has_rebuttal=False,
    )
