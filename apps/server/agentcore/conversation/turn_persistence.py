"""End-of-turn persistence facades — delegate to CloudStore (ConversationStore).

Progressive placeholder / finalize / salvage live on ``CloudStore``; this module
keeps the historical import paths and host-side helpers (open-pause detection,
salvage scheduling) stable for turn_runner / turns / tests.
"""

from agentcore.config import settings
from agentcore.conversation.background import spawn_background
from agentcore.conversation.store import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_FAILED,
    MESSAGE_STATUS_INCOMPLETE,
    MESSAGE_STATUS_RUNNING,
    get_cloud_store,
)
from agentcore.core.logging import get_logger
from agentcore.llm.resolve import LLMCredentials
from agentcore.runtime.events import EventSink
from agentcore.workspace.protocol import WorkspaceBackend

logger = get_logger(__name__)

# Re-export status constants for callers / tests that imported them here.
__all__ = [
    "MESSAGE_STATUS_COMPLETE",
    "MESSAGE_STATUS_FAILED",
    "MESSAGE_STATUS_INCOMPLETE",
    "MESSAGE_STATUS_RUNNING",
    "create_assistant_placeholder",
    "has_open_durable_pause",
    "persist_incomplete_turn",
    "persist_turn_result",
    "salvage_incomplete_turn",
]

_PAUSE_REQUIRED_TYPES = ("checkpoint_required", "plan_review_required", "team_preview_required")
_PAUSE_RESOLVED_TYPES = ("checkpoint_resolved", "plan_review_resolved", "team_preview_resolved")


async def create_assistant_placeholder(
    *,
    conversation_id: str,
    message_id: str,
    trace_id: str,
) -> None:
    """Create the running assistant row at turn start (progressive persistence)."""
    await get_cloud_store().begin_turn(
        conversation_id=conversation_id,
        message_id=message_id,
        trace_id=trace_id,
    )


def has_open_durable_pause(journal: list[dict]) -> bool:
    """True if the journal ends on an UNRESOLVED plan_review / ask_user checkpoint."""
    required: set[str] = set()
    resolved: set[str] = set()
    for event in journal:
        cid = (event.get("payload") or {}).get("checkpoint_id")
        if not cid:
            continue
        if event.get("type") in _PAUSE_REQUIRED_TYPES:
            required.add(cid)
        elif event.get("type") in _PAUSE_RESOLVED_TYPES:
            resolved.add(cid)
    return bool(required - resolved)


async def persist_turn_result(
    *,
    result: dict,
    conversation_id: str,
    user_id: str,
    folder_id: str | None,
    backend: WorkspaceBackend,
    sink: EventSink,
    user_message: str,
    generate_title: bool,
    llm_credentials: LLMCredentials | None,
    trace_id: str,
    turn_id: str,
    duration_ms: int,
    kind: str = "turn",
) -> None:
    """Persist a completed turn via ``CloudStore.finalize(mode="cloud")``."""
    await get_cloud_store().finalize(
        mode="cloud",
        result=result,
        conversation_id=conversation_id,
        user_id=user_id,
        folder_id=folder_id,
        backend=backend,
        sink=sink,
        user_message=user_message,
        generate_title=generate_title,
        llm_credentials=llm_credentials,
        trace_id=trace_id,
        turn_id=turn_id,
        duration_ms=duration_ms,
        kind=kind,
    )


async def persist_incomplete_turn(
    *,
    journal: list[dict],
    content: str,
    conversation_id: str,
    trace_id: str,
    message_id: str | None,
) -> None:
    """Persist a cancelled turn's already-streamed reply + finished work."""
    await get_cloud_store().salvage(
        journal=journal,
        content=content,
        conversation_id=conversation_id,
        trace_id=trace_id,
        message_id=message_id,
    )


def salvage_incomplete_turn(
    *,
    sink: EventSink,
    conversation_id: str,
    trace_id: str,
    message_id: str | None = None,
) -> None:
    """On a turn cancel, schedule saving its streamed reply + finished work as one message.

    Salvages when there is EITHER finished team work (a replayable journal) OR the CEO had
    streamed some reply text — so a cancelled pure-text answer (no team/tool journal surface)
    is no longer silently dropped. Skips a turn parked at an unresolved durable checkpoint
    (its paused frame is the record).
    """
    if not settings.incomplete_turn_persist_enabled:
        return
    if not message_id:
        return
    journal = sink.execution_journal()
    content = sink.streamed_content()
    if not journal and not content.strip():
        return
    suspend_frames = settings.structured_suspension_persist_enabled
    if journal and suspend_frames and has_open_durable_pause(journal):
        return
    spawn_background(
        persist_incomplete_turn(
            journal=list(journal) if journal else [],
            content=content,
            conversation_id=conversation_id,
            trace_id=trace_id,
            message_id=message_id,
        )
    )
