"""Engine-level wall-clock ceilings for tool execution."""

from agentcore.config import settings
from agentcore.core.types import ToolCategory
from agentcore.tools.protocol import ToolSchema

from .constants import TIMEOUT_EXEMPT_CATEGORIES


def resolve_tool_timeout(schema: ToolSchema) -> float | None:
    """The engine-level wall-clock ceiling (seconds) for one call of this tool.

    ``None`` ⇒ no engine backstop (the tool manages its own lifecycle). Precedence:
    an explicit ``schema.timeout_seconds`` wins; else the tool's category decides —
    ORCHESTRATION / INTERACTION are exempt (``None``), EXECUTION gets the higher
    execution ceiling (it runs code), everything else the default. This is a coarse
    safety net layered above each tool's own finer timeout, never a replacement (B1).
    """
    if schema.timeout_seconds is not None:
        return schema.timeout_seconds
    if schema.category in TIMEOUT_EXEMPT_CATEGORIES:
        return None
    if schema.category is ToolCategory.EXECUTION:
        return settings.tool_execution_timeout_seconds
    return settings.tool_default_timeout_seconds
