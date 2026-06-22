"""辩论编排包（主持人驱动的辩论 / 交叉审查能力）。

把辩论从「`delegate` 上的 stance/round 展示标记 + CEO 手搓跨轮 DAG」重设计为「主持人
（:class:`Moderator`）驱动、过程与结论双产物」的产品能力。底层执行仍复用现有 DAG 调度
（``build_agent_executor`` / ``continue_run`` / ``WaveScheduler``），本包只补「主持 / 收敛 /
双产物」的产品层。

→ 见设计: docs/03-AI核心/辩论编排设计.md
"""

from __future__ import annotations

from agentcore.runtime.debate.moderator import Moderator
from agentcore.runtime.debate.types import (
    DEFAULT_MAX_ROUNDS,
    DEFAULT_MAX_ROUNDS_QUICK,
    DEFAULT_MAX_ROUNDS_ROUNDTABLE,
    STOP_ALL_FAILED,
    STOP_CONVERGED,
    STOP_FOCUS_CLARIFIED,
    STOP_MAX_ROUNDS,
    STOP_REASONS,
    STOP_RED_TEAM_EXHAUSTED,
    DebateBrief,
    DebateConfig,
    DebateForm,
    DebateResult,
    DebateSide,
    JudgeVerdict,
    RoundPolicy,
    RoundResult,
    RoundRunner,
    SideTurn,
)

__all__ = [
    "Moderator",
    "DebateForm",
    "DebateSide",
    "DebateConfig",
    "RoundPolicy",
    "SideTurn",
    "JudgeVerdict",
    "RoundResult",
    "DebateBrief",
    "DebateResult",
    "RoundRunner",
    "DEFAULT_MAX_ROUNDS",
    "DEFAULT_MAX_ROUNDS_QUICK",
    "DEFAULT_MAX_ROUNDS_ROUNDTABLE",
    "STOP_CONVERGED",
    "STOP_FOCUS_CLARIFIED",
    "STOP_RED_TEAM_EXHAUSTED",
    "STOP_MAX_ROUNDS",
    "STOP_ALL_FAILED",
    "STOP_REASONS",
]
