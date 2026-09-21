"""Ratchet: Conversation ``*folder_id`` columns must be registered for delete.

New soft-pointer → add to ``FOLDER_NULL_ON_DELETE_POINTERS`` (auto-cleared).
New affiliation column with call-site semantics → ``FOLDER_AFFILIATION_COLUMNS``.
Leftover unread column (not written, not cleared) → ``FOLDER_UNREAD_COLUMNS``.
"""

from agentcore.db.models import Conversation
from agentcore.folders.unbind import (
    FOLDER_AFFILIATION_COLUMNS,
    FOLDER_NULL_ON_DELETE_POINTERS,
    FOLDER_UNREAD_COLUMNS,
)


def _folder_id_columns(*models: type) -> set[tuple[type, str]]:
    found: set[tuple[type, str]] = set()
    for model in models:
        for col in model.__table__.columns:
            if col.name == "folder_id" or col.name.endswith("_folder_id"):
                found.add((model, col.name))
    return found


def test_folder_session_pointer_registry_covers_conversation():
    discovered = _folder_id_columns(Conversation)
    registered = (
        set(FOLDER_NULL_ON_DELETE_POINTERS)
        | FOLDER_AFFILIATION_COLUMNS
        | FOLDER_UNREAD_COLUMNS
    )
    assert discovered == registered, (
        "New Conversation folder pointer column must be listed in "
        "FOLDER_NULL_ON_DELETE_POINTERS (NULL on delete), "
        "FOLDER_AFFILIATION_COLUMNS (call-site membership semantics), or "
        "FOLDER_UNREAD_COLUMNS (leftover unread). "
        f"missing={discovered - registered!r} extra={registered - discovered!r}"
    )
