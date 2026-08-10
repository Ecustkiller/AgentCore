"""Parallel tool execution for one ReAct round.

Thin facade: implementation is split by axis —

* ``tool_exec_gates`` — approval / destructive baseline
* ``tool_exec_args`` — args sanitize / miss feedback / failure markers
* ``tool_exec_parallel`` — parallel execute orchestration
* ``tool_exec_coalesce`` — same-round file_read path coalesce helpers
* ``tool_exec_citations`` — citation sink / ledger side-effects

Public import paths (``execute_tools``, ``TOOL_FAILED_MARKER``,
``with_tool_failed_marker``, ``_apply_local_destructive_baseline_gate``) stay stable.
"""

from .tool_exec_args import TOOL_FAILED_MARKER, with_tool_failed_marker
from .tool_exec_gates import _apply_local_destructive_baseline_gate
from .tool_exec_parallel import execute_tools

__all__ = [
    "TOOL_FAILED_MARKER",
    "_apply_local_destructive_baseline_gate",
    "execute_tools",
    "with_tool_failed_marker",
]
