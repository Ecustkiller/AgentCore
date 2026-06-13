"""Shared enumerations and base types used across all modules."""

from enum import StrEnum
from typing import NewType
from uuid import uuid4

# --- ID Types ---

ConversationId = NewType("ConversationId", str)
ExecutionId = NewType("ExecutionId", str)
StepId = NewType("StepId", str)
AgentId = NewType("AgentId", str)
UserId = NewType("UserId", str)
MessageId = NewType("MessageId", str)
TurnId = NewType("TurnId", str)


def new_id() -> str:
    return str(uuid4())


# --- Core Enumerations ---


class ModelTier(StrEnum):
    """Orchestrator output model preference, mapped to concrete model at runtime."""

    FAST = "fast"
    STANDARD = "standard"
    STRONG = "strong"


class ExecutionStatus(StrEnum):
    PLANNING = "planning"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StepStatus(StrEnum):
    PENDING = "pending"
    READY = "ready"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class PlanType(StrEnum):
    SINGLE_AGENT = "single_agent"
    MULTI_AGENT = "multi_agent"
    DEBATE = "debate"


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
