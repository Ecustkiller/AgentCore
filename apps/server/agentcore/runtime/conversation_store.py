"""Process-wide ConversationStore bind/get (host installs the impl).

The protocol lives in ``runtime.ports``. Cloud default is ``CloudStore`` via a
factory ``conversation.service`` installs (lazy, so sidecar import does not pull
Postgres / Pillow). Sidecar ``initialize`` binds ``OutboxStore``.

Interrupt still uses ``get_cloud_store``: the active store on sidecar is Outbox,
and cancel must read/clear cloud stream segments.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from agentcore.runtime.ports import ConversationStore

_active_store: ConversationStore | None = None
_default_factory: Callable[[], ConversationStore] | None = None


def bind_conversation_store(store: ConversationStore) -> None:
    """Install the active ConversationStore (sidecar → OutboxStore; tests → fake)."""
    global _active_store
    _active_store = store


def set_conversation_store_factory(factory: Callable[[], ConversationStore]) -> None:
    """Cloud composition root: unbound ``get`` uses this (typically CloudStore)."""
    global _default_factory
    _default_factory = factory


def get_conversation_store() -> ConversationStore:
    """Return the process-wide ConversationStore (CloudStore unless sidecar swapped)."""
    global _active_store
    if _active_store is None:
        if _default_factory is None:
            raise RuntimeError(
                "ConversationStore is not bound; import agentcore.conversation.service "
                "or call bind_conversation_store"
            )
        _active_store = _default_factory()
    return _active_store


def reset_conversation_store_for_tests() -> None:
    """Drop the active instance so the next get uses the default factory again."""
    global _active_store
    _active_store = None
