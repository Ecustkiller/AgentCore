"""Host-side AGENT run executor: run one RunSpec node via the shared ReAct loop.

Thin facade — implementation split across executor_*.py modules.
→ 见设计: docs/03-AI核心/执行引擎架构设计.md §八（Run 模型）
"""

from __future__ import annotations

from agentcore.runtime.runs.executor_agent import build_agent_executor
from agentcore.runtime.runs.executor_captain import (
    build_captain_executor,
    build_captain_resumer,
)
from agentcore.runtime.runs.executor_context import (
    _CONTEXT_BLOCK_BODY_CAP,
    _ancestors_by_id,
    _build_captain_context_blocks,
    _build_context_blocks,
    _build_messages,
    _context_block_payloads,
    _dep_context_blocks,
    _format_captain_history,
    _safe_index_files,
    _team_position_block,
    _workspace_manifest,
)
from agentcore.runtime.runs.executor_continue import continue_run
from agentcore.runtime.runs.executor_identities import ESCALATION_CONCURRENCY_CAP, DelegateFactory
from agentcore.runtime.runs.executor_shared import (
    _is_hard_failure,
    _priced_failure,
    _react_and_capture,
    _registry_with,
    _retry_message,
    _revision_message,
)

__all__ = [
    "DelegateFactory",
    "ESCALATION_CONCURRENCY_CAP",
    "build_agent_executor",
    "build_captain_executor",
    "build_captain_resumer",
    "continue_run",
    "_CONTEXT_BLOCK_BODY_CAP",
    "_ancestors_by_id",
    "_build_captain_context_blocks",
    "_build_context_blocks",
    "_build_messages",
    "_context_block_payloads",
    "_dep_context_blocks",
    "_format_captain_history",
    "_is_hard_failure",
    "_priced_failure",
    "_react_and_capture",
    "_registry_with",
    "_retry_message",
    "_revision_message",
    "_safe_index_files",
    "_team_position_block",
    "_workspace_manifest",
]
