"""debate: CEO 发起结构化正反辩论的编排原语（主持人驱动）。

→ 见设计: docs/03-AI核心/辩论编排设计.md
"""

from __future__ import annotations

from agentcore.tools.builtin.debate.schema import DEBATE_OUTPUT_LIMIT
from agentcore.tools.builtin.debate.tool import DebateTool

__all__ = [
    "DEBATE_OUTPUT_LIMIT",
    "DebateTool",
]
