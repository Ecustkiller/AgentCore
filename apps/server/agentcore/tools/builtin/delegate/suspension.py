"""Durable plan_review suspension (结构化挂起 2b)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.core.logging import get_logger

if TYPE_CHECKING:
    from agentcore.runtime.runs.plan import RunPlan
    from agentcore.tools.builtin.delegate.tool import DelegateTool

logger = get_logger(__name__)


def can_persist_suspension(tool: DelegateTool) -> bool:
    """Whether this checkpoint should be durably persisted (结构化挂起 2b)."""
    return bool(
        tool._depth == 0
        and tool._message_id
        and tool._suspension_saver is not None
        and tool._conversation_id
    )


async def persist_suspension(
    tool: DelegateTool,
    checkpoint_id,
    plan: RunPlan,
    completed,
    steps,
    pending,
    required_event,
) -> None:
    """Capture + persist the durable suspension frame for this pause (2b)."""
    if not can_persist_suspension(tool):
        return
    from agentcore.core.log_context import get_log_value
    from agentcore.runtime.suspension import (
        PlanReviewSuspension,
        captain_transcript,
        find_tool_call_id,
        turn_history,
    )

    transcript = captain_transcript.get()
    if not transcript:
        logger.info("suspension.no_transcript", checkpoint_id=checkpoint_id)
        return
    from agentcore.runtime.facts import snapshot_fact_log

    journal = list(tool._sink.execution_journal() or [])
    journal.append(
        {
            "type": required_event.type.value,
            "payload": required_event.payload,
            "timestamp": required_event.timestamp,
        }
    )
    journal_entries = snapshot_fact_log(
        trailing=[
            {
                "kind": required_event.type.value,
                "payload": required_event.payload,
                "ts": required_event.timestamp,
            }
        ]
    )
    frame = PlanReviewSuspension(
        message_id=tool._message_id or "",
        conversation_id=tool._conversation_id or "",
        user_id=tool._base_tool_context.user_id,
        captain_run_id=tool._captain_run_id or "",
        checkpoint_id=checkpoint_id,
        tool_call_id=find_tool_call_id(transcript, "delegate"),
        base_system_prompt=tool._system_prompt,
        user_message=tool._user_message,
        folder_id=tool._folder_id,
        memory_enabled=tool._memory_enabled,
        transcript=list(transcript),
        history=list(turn_history.get() or []),
        plan=plan,
        completed=dict(completed),
        journal=journal,
        journal_entries=journal_entries,
        steps=steps,
        pending=pending,
        trace_id=get_log_value("trace_id"),
    )
    await tool._suspension_saver(frame)  # type: ignore[misc]


async def drop_suspension(tool: DelegateTool) -> None:
    """Delete the durable frame after a live in-process resolve / timeout (2b)."""
    if can_persist_suspension(tool) and tool._suspension_deleter is not None:
        await tool._suspension_deleter(tool._message_id or "")
