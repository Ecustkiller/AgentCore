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
    # Currently UNUSED: ``consult_skill`` was recategorised to ORCHESTRATION (it is a CEO
    # orchestration primitive, and 技能 are Prompt injection shown in the「AI 提示词」
    # catalog — not a tool group). Kept as declarative metadata so the contract type is
    # stable; removable via ``pnpm gen:types`` once we're sure no future skill-category
    # tool wants it. Like every category, the engine never branches on it.
    SKILL = "skill"


class ToolEffect(StrEnum):
    """How a tool result steers the ReAct loop.

    The engine acts on THIS effect — never on a tool's name or category (引擎纯化,
    设计 §8.5). The default ``CONTINUE`` feeds the tool output back and loops; a
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
    # The tool drove a user interaction that ended the turn, and its text is the
    # final answer: the CEO ``ask_user`` checkpoint on a "stop" decision (its closing
    # note is the reply). A "submit" answer instead resumes the loop (CONTINUE), so
    # only stop is terminal here.
    INTERACT = "interact"
    # 挂起即收口 (②): the tool hit a durable checkpoint and persisted a resume frame, so
    # the loop must END the turn awaiting ``POST .../resume`` — NOT because an answer was
    # produced. Unlike INTERACT/HANDOFF it carries NO ``final_text`` (there is no reply
    # yet) and the suspended tool_call is left PENDING (no tool result recorded), so the
    # resumed window ends exactly at the assistant. The engine maps it to
    # FinishReason.PAUSED. Returned by any durable checkpoint whose frame was persisted
    # (§六-1 narrow fallback: an un-persistable pause parks on the in-memory wait instead).
    SUSPEND = "suspend"
