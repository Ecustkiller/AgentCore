"""Nested sub-team delegate tools."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.tools.builtin.delegate.tool import DelegateTool


def make_child(tool: DelegateTool, captain_run_id: str, captain_depth: int) -> DelegateTool:
    """Mint a delegate tool for a worker that leads one nested sub-team (阶段2)."""
    from agentcore.tools.builtin.delegate.tool import DelegateTool as DelegateToolCls

    child = DelegateToolCls(
        llm=tool._llm,
        sink=tool._sink,
        system_prompt=tool._system_prompt,
        user_message=tool._user_message,
        history=tool._history,
        tools=tool._tools,
        base_tool_context=tool._base_tool_context,
        profile_set=tool._profile_set,
        max_parallel=tool._max_parallel,
        captain_run_id=captain_run_id,
        approval_gate=tool._approval_gate,
        session_store=tool._session_store,
        session_saver=tool._session_saver,
        conversation_id=tool._conversation_id,
        registry=tool._registry,
        checkpoint_timeout_seconds=tool._checkpoint_timeout_seconds,
        checkpoint_enabled=tool._checkpoint_enabled,
        depth=captain_depth,
    )
    tool._children.append(child)
    return child


def absorb_children(tool: DelegateTool) -> None:
    """Fold every nested sub-team spawned this call into the turn totals."""
    for child in tool._children:
        tool._acc.merge(child._acc)
    tool._children.clear()
