"""SQLAlchemy ORM model definitions, split by domain.

This ORM is the single source of truth for the AgentCore schema; structure is
applied via Alembic migrations (``alembic check`` must report zero drift).

This package was split out of a single ``models.py`` along the same domain seams as
``db/repositories`` (auth / billing / chat / conversations / devices / model_modes /
runs / users). Importing the package imports every model module, so all tables
register on ``Base.metadata`` exactly as before (Alembic's ``env.py`` and
``Base.metadata.create_all`` see the full set). This ``__init__`` re-exports the full
class surface so the historical import path — ``from agentcore.db.models import X`` —
keeps working unchanged across the codebase; ``_new_uuid`` is re-exported because it
was a module-level name on the original module.
"""

from ._helpers import _new_uuid
from .admin_audit import AdminAuditLog
from .auth import Credentials, Invite, RefreshToken, UserLlmKey
from .billing import CostEvent
from .boards import Board
from .chat import Chat, ChatMember, ChatMessage
from .conversations import (
    Conversation,
    ConversationShare,
    Folder,
    MemoryUpdateRow,
    Message,
)
from .devices import PushDeviceRow
from .model_modes import ModelMode
from .runs import (
    HandoffJob,
    PausedTurnRow,
    RunSessionRow,
    TurnJournalRow,
    TurnMetricsRow,
)
from .users import User, UserBlock, UserDirectorySettings

__all__ = [
    "AdminAuditLog",
    "Board",
    "Chat",
    "ChatMember",
    "ChatMessage",
    "Conversation",
    "ConversationShare",
    "CostEvent",
    "Credentials",
    "Folder",
    "HandoffJob",
    "Invite",
    "MemoryUpdateRow",
    "Message",
    "ModelMode",
    "PausedTurnRow",
    "PushDeviceRow",
    "RefreshToken",
    "RunSessionRow",
    "TurnJournalRow",
    "TurnMetricsRow",
    "User",
    "UserBlock",
    "UserDirectorySettings",
    "UserLlmKey",
    "_new_uuid",
]
