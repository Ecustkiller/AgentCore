"""ConversationStore implementations (turn-authority persistence driver).

Process-wide bind/get lives in ``agentcore.runtime.conversation_store``.
``CloudStore`` is lazy-exported: eager import pulls memory consolidation → messaging
→ Pillow, which is outside the sidecar runtime subset. Sidecar only needs
``OutboxStore`` (+ merge constants) at import time.
"""

from __future__ import annotations

from typing import Any

from agentcore.conversation.store.merge import (
    MESSAGE_STATUS_COMPLETE,
    MESSAGE_STATUS_FAILED,
    MESSAGE_STATUS_INCOMPLETE,
    MESSAGE_STATUS_RUNNING,
)
from agentcore.conversation.store.outbox import OutboxStore

__all__ = [
    "MESSAGE_STATUS_COMPLETE",
    "MESSAGE_STATUS_FAILED",
    "MESSAGE_STATUS_INCOMPLETE",
    "MESSAGE_STATUS_RUNNING",
    "CloudStore",
    "OutboxStore",
    "get_cloud_store",
]

_CLOUD_EXPORTS = frozenset({"CloudStore", "get_cloud_store"})


def __getattr__(name: str) -> Any:
    if name in _CLOUD_EXPORTS:
        from agentcore.conversation.store import cloud as _cloud

        return getattr(_cloud, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
