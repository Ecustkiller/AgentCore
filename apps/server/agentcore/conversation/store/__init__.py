"""ConversationStore implementations (turn-authority persistence driver)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from agentcore.conversation.store.cloud import CloudStore, get_cloud_store
from agentcore.conversation.store.merge import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_FAILED,
    MESSAGE_STATUS_INCOMPLETE,
    MESSAGE_STATUS_RUNNING,
)
from agentcore.conversation.store.outbox import OutboxStore

if TYPE_CHECKING:
    from agentcore.runtime.ports import ConversationStore

__all__ = [
    "MESSAGE_STATUS_COMPLETE",
    "MESSAGE_STATUS_FAILED",
    "MESSAGE_STATUS_INCOMPLETE",
    "MESSAGE_STATUS_RUNNING",
    "CloudStore",
    "OutboxStore",
    "get_cloud_store",
    "get_conversation_store",
    "set_conversation_store",
    "reset_conversation_store_for_tests",
]

# Process-wide active ConversationStore. Cloud host defaults to CloudStore; the
# sidecar swaps in OutboxStore on initialize (as-built: 双模式工作区 §10.3; 执行引擎 §8.6).
_active_store: ConversationStore | None = None


def get_conversation_store() -> ConversationStore:
    """Return the process-wide ConversationStore (CloudStore unless sidecar swapped)."""
    global _active_store
    if _active_store is None:
        _active_store = get_cloud_store()
    return _active_store


def set_conversation_store(store: ConversationStore) -> None:
    """Install the active ConversationStore (sidecar → OutboxStore)."""
    global _active_store
    _active_store = store


def reset_conversation_store_for_tests() -> None:
    """Drop the override so the next get returns a fresh CloudStore default."""
    global _active_store
    _active_store = None
