"""Shared enumerations and base types used across all modules."""

from enum import StrEnum
from uuid import uuid4


def new_id() -> str:
    return str(uuid4())


# --- Core Enumerations ---


class ModelTier(StrEnum):
    """CEO/``delegate`` worker model preference (two tiers), mapped to a concrete
    agent profile at runtime.

    The single-chat/default reply path is intentionally NOT a tier: it uses the
    standalone ``chat`` profile so everyday chat stays decoupled from ``strong``.
    """

    FAST = "fast"
    STRONG = "strong"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class ToolApproval(StrEnum):
    """Tool approval requirement levels."""

    NEVER = "never"
    GRANTABLE = "grantable"
    ALWAYS = "always"


class ToolCategory(StrEnum):
    FILESYSTEM = "filesystem"
    SEARCH = "search"
    EXECUTION = "execution"
    RESEARCH = "research"
    ORCHESTRATION = "orchestration"
