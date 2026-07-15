"""Conformance vector builders — debate and roundtable scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import SSEEvent

from .debate_followup import _multi_agent_debate_followup
from .debate_multibeat import _multi_agent_debate_multibeat
from .debate_single import _multi_agent_debate
from .red_team import _multi_agent_red_team
from .roundtable import _multi_agent_roundtable_rounds, _multi_agent_roundtable_settled

VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_debate": ("多 Agent：辩论（debate 工具）主持人→辩手 + 决策简报/叙事线双产物", _multi_agent_debate),
    "multi_agent_debate_multibeat": (
        "多 Agent：多轮对抗辩论 + 每轮质询 + 结辩（协作图 beat 列 / channel 角标契约）",
        _multi_agent_debate_multibeat,
    ),
    "multi_agent_debate_followup": ("多 Agent：辩论收场带用户追问（user_interjections verbatim 复盘）", _multi_agent_debate_followup),
    "multi_agent_roundtable_rounds": (
        "刷新重建（P2）：圆桌逐轮 debate_round_started/debate_round DURABLE → debateRounds 进行态",
        _multi_agent_roundtable_rounds,
    ),
    "multi_agent_red_team": ("多 Agent：红队审查收场（form=red_team）风险看板 + 加固建议 + 方案方回应双产物", _multi_agent_red_team),
    "multi_agent_roundtable_settled": ("多 Agent：圆桌探讨收场（form=roundtable）观点光谱英雄区 + 叙事后简报小结双产物", _multi_agent_roundtable_settled),
}
