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
    # A tool that pauses the turn to ask the user (the CEO ``ask_user`` checkpoint).
    # Category is declarative metadata for classification/tooling; the engine no
    # longer branches on tool category (it acts on the ToolResult, not the name).
    INTERACTION = "interaction"


class ToolEffect(StrEnum):
    """How a tool result steers the ReAct loop.

    The engine acts on THIS effect — never on a tool's name or category (引擎纯化,
    设计 §18.5). The default ``CONTINUE`` feeds the tool output back and loops; a
    terminal effect ends the turn in-band, surfacing the result's ``final_text``
    instead of letting the model generate a second, duplicate reply.
    """

    # Default: feed the tool output back to the model and keep looping.
    CONTINUE = "continue"
    # The tool already produced AND streamed the turn's final user-facing answer
    # itself, so the loop must stop. Reserved: no current built-in sets it (the
    # legacy answer-streaming handoff was retired) — kept as the effect a future
    # streaming-handoff tool would declare.
    HANDOFF = "handoff"
    # The tool drove a user interaction that ended the turn (the CEO ``ask_user``
    # checkpoint on a "stop" decision): its closing note is the final answer.
    INTERACT = "interact"
