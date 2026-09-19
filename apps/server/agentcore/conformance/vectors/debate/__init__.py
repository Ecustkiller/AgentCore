"""Conformance vector builders — debate scenarios.

See ``vectors/__init__.py`` for the aggregated ``VECTORS`` registry.
"""

from __future__ import annotations

from collections.abc import Callable

from agentcore.runtime.events import SSEEvent

from .debate_multibeat import _multi_agent_debate_multibeat
from .debate_single import _multi_agent_debate

VECTORS: dict[str, tuple[str, Callable[[], list[SSEEvent]]]] = {
    "multi_agent_debate": ("多 Agent：辩论（debate 工具）主持人→辩手 + 决策简报/叙事线双产物", _multi_agent_debate),
    "multi_agent_debate_multibeat": (
        "多 Agent：多轮对抗辩论 + 每轮质询（协作图 beat 列 / channel 角标契约）",
        _multi_agent_debate_multibeat,
    ),
}
