"""delegate: the CEO main-agent's single orchestration primitive (统一 Run 模型 阶段3).

→ 见设计: docs/03-AI核心/编排器与CEO主Agent.md §一（delegate 原语）
"""

from __future__ import annotations

from agentcore.tools.builtin.delegate.schema import (
    DELEGATE_OUTPUT_LIMIT,
    _DELEGATE_OUTPUT_LIMIT,
)
from agentcore.tools.builtin.delegate.tool import DelegateTool

__all__ = [
    "DELEGATE_OUTPUT_LIMIT",
    "DelegateTool",
    "_DELEGATE_OUTPUT_LIMIT",
]
