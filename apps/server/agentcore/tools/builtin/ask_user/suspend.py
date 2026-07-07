"""Durable ask_user suspension (结构化挂起 2b)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from agentcore.core.logging import get_logger
from agentcore.runtime.checkpoints import AskCheckpointIntent
from agentcore.tools.protocol import ToolContext

if TYPE_CHECKING:
    from agentcore.tools.builtin.ask_user.tool import AskUserTool

logger = get_logger(__name__)


def can_persist_suspension(tool: AskUserTool) -> bool:
    """Whether this ask_user pause should be durably persisted (结构化挂起 2b).

    The turn's ``message_id`` + the persist closure must be wired (the live CEO
    path) — a standalone / un-wired construction (tests) keeps 2a in-memory only."""
    return bool(tool.message_id and tool.suspension_saver is not None and tool.conversation_id)


async def persist_suspension(
    tool: AskUserTool,
    *,
    checkpoint_id: str,
    context: ToolContext,
    message: str,
    ctx_text: str,
    assumptions: list[dict[str, Any]],
    questions: list[dict[str, Any]],
    style_options: list[dict[str, Any]],
    required_event: Any,
    intent: AskCheckpointIntent,
) -> bool:
    """Capture + persist the durable suspension frame for this ask_user pause (2b).

    Reads the CEO transcript off the ``captain_transcript`` contextvar (published
    by the captain executor) — without it a faithful resume is impossible, so
    capture is skipped (the live resolve still works). Folds the about-to-emit
    ``checkpoint_required`` into the frame's journal so a resume replays the
    prompt+resolution as a pair. Best-effort: the saver swallows its own errors.

    Returns ``True`` iff a durable frame was actually saved. The 挂起即收口 (②)
    finalize path keys its「end the turn now」decision on this so it NEVER finalizes a
    turn it could not later resume — an un-wired / transcript-less construction (tests,
    标准 standalone) returns ``False`` and falls back to the in-memory wait.
    """
    if not can_persist_suspension(tool):
        return False
    from agentcore.core.log_context import get_log_value
    from agentcore.runtime.suspension import (
        AskUserSuspension,
        captain_transcript,
        find_tool_call_id,
        turn_history,
    )

    transcript = captain_transcript.get()
    if not transcript:
        logger.info("suspension.no_transcript", checkpoint_id=checkpoint_id)
        return False
    from agentcore.runtime.facts import snapshot_fact_log

    journal = list(tool.sink.execution_journal() or [])
    journal.append(
        {
            "type": required_event.type.value,
            "payload": required_event.payload,
            "timestamp": required_event.timestamp,
        }
    )
    # The §8.3 fact-log stream at this same instant — the persist source (the
    # display ``journal`` above is the degraded fallback). The suspending card is
    # emitted only AFTER this save, so fold it in so the persisted stream carries it.
    journal_entries = snapshot_fact_log(
        trailing=[
            {
                "kind": required_event.type.value,
                "payload": required_event.payload,
                "ts": required_event.timestamp,
            }
        ]
    )
    frame = AskUserSuspension(
        message_id=tool.message_id or "",
        conversation_id=tool.conversation_id,
        user_id=context.user_id,
        captain_run_id=tool.captain_run_id or "",
        checkpoint_id=checkpoint_id,
        tool_call_id=find_tool_call_id(transcript, "ask_user"),
        base_system_prompt=tool.base_system_prompt,
        user_message=tool.user_message,
        folder_id=tool.folder_id,
        memory_enabled=tool.memory_enabled,
        transcript=list(transcript),
        history=list(turn_history.get() or []),
        question=message,
        context=ctx_text,
        assumptions=assumptions,
        questions=questions,
        style_options=style_options,
        intent=intent,
        journal=journal,
        journal_entries=journal_entries,
        trace_id=get_log_value("trace_id"),
    )
    await tool.suspension_saver(frame)  # type: ignore[misc]
    return True


async def drop_suspension(tool: AskUserTool) -> None:
    """Delete the durable frame after a live in-process resolve / timeout (2b)."""
    if can_persist_suspension(tool) and tool.suspension_deleter is not None:
        await tool.suspension_deleter(tool.message_id or "")
