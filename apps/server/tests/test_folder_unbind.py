"""Ratchet: Conversation/Board ``*folder_id`` columns must be registered for delete.

New soft-pointer → add to ``FOLDER_NULL_ON_DELETE_POINTERS`` (auto-cleared).
New affiliation column with call-site semantics → ``FOLDER_AFFILIATION_COLUMNS``.
"""

from agentcore.db.models import Board, Conversation
from agentcore.folders.unbind import (
    FOLDER_AFFILIATION_COLUMNS,
    FOLDER_NULL_ON_DELETE_POINTERS,
)


def _folder_id_columns(*models: type) -> set[tuple[type, str]]:
    found: set[tuple[type, str]] = set()
    for model in models:
        for col in model.__table__.columns:
            if col.name == "folder_id" or col.name.endswith("_folder_id"):
                found.add((model, col.name))
    return found


def test_folder_session_pointer_registry_covers_conversation_and_board():
    discovered = _folder_id_columns(Conversation, Board)
    registered = set(FOLDER_NULL_ON_DELETE_POINTERS) | FOLDER_AFFILIATION_COLUMNS
    assert discovered == registered, (
        "New Conversation/Board folder pointer column must be listed in "
        "FOLDER_NULL_ON_DELETE_POINTERS (NULL on delete) or "
        "FOLDER_AFFILIATION_COLUMNS (call-site membership semantics). "
        f"missing={discovered - registered!r} extra={registered - discovered!r}"
    )
