"""Data access layer (Repository pattern), split by domain.

Each repository handles CRUD for a single model:
- Only data access, no business logic
- Uses select() builder pattern
- Pagination returns (data, total_count)
- Default sort: created_at desc
- commit() and refresh() handled internally

This package was split out of a single ``repositories.py`` along domain seams
(file-splitting.mdc). This ``__init__`` re-exports the full public surface so the
historical import path — ``from agentcore.db.repositories import XRepository`` —
keeps working unchanged across the codebase. ``_ilike_pattern`` is re-exported
because the global-search tests import it directly.
"""

from ._base import _UNSET, _ilike_pattern
from .admin_audit import AdminAuditRepository
from .auth import (
    CredentialsRepository,
    InviteRepository,
    RefreshTokenRepository,
    UserLlmKeyRepository,
)
from .billing import CostEventRepository
from .chat import ChatRepository
from .conversation_shares import ConversationShareRepository
from .conversations import ConversationRepository
from .devices import PushDeviceRepository
from .folders import FolderRepository
from .messages import MessageRepository
from .model_modes import ModelModeRepository
from .runs import (
    HandoffJobRepository,
    PausedTurnRepository,
    RunSessionRepository,
    TurnJournalRepository,
    TurnMetricsRepository,
)
from .users import (
    UserBlockRepository,
    UserDirectoryRepository,
    UserRepository,
)

__all__ = [
    "_UNSET",
    "_ilike_pattern",
    "AdminAuditRepository",
    "ChatRepository",
    "ConversationRepository",
    "ConversationShareRepository",
    "CostEventRepository",
    "CredentialsRepository",
    "FolderRepository",
    "HandoffJobRepository",
    "InviteRepository",
    "MessageRepository",
    "ModelModeRepository",
    "PausedTurnRepository",
    "PushDeviceRepository",
    "RefreshTokenRepository",
    "RunSessionRepository",
    "TurnJournalRepository",
    "TurnMetricsRepository",
    "UserBlockRepository",
    "UserDirectoryRepository",
    "UserLlmKeyRepository",
    "UserRepository",
]
