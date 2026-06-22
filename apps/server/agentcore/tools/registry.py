"""ToolRegistry: registration and query of available tools.

Manages all registered tools and provides lookup by name or category.
Also converts tool schemas to LLM function calling format.
"""

from agentcore.core.errors import ToolNotFoundError
from agentcore.core.types import ToolCategory
from agentcore.tools.protocol import Tool, ToolSchema, tool_schema_to_openai_format


class ToolRegistry:
    """Central registry for all available tools."""

    def __init__(self):
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> None:
        """Register a tool. Raises ValueError if name already registered."""
        name = tool.schema.name
        if name in self._tools:
            raise ValueError(f"Tool '{name}' is already registered")
        self._tools[name] = tool

    def get(self, name: str) -> Tool:
        """Get a tool by name. Raises ToolNotFoundError if not found."""
        tool = self._tools.get(name)
        if tool is None:
            raise ToolNotFoundError(f"工具 '{name}' 不存在")
        return tool

    def get_optional(self, name: str) -> Tool | None:
        """Get a tool by name, returning None if not found."""
        return self._tools.get(name)

    def list_all(self) -> list[ToolSchema]:
        """Return schemas of all registered tools."""
        return [tool.schema for tool in self._tools.values()]

    def list_by_category(self, category: ToolCategory) -> list[ToolSchema]:
        """Return schemas of tools in a given category."""
        return [tool.schema for tool in self._tools.values() if tool.schema.category == category]

    def get_openai_definitions(self, tool_names: list[str] | None = None) -> list[dict]:
        """Return tool definitions in OpenAI function calling format.

        If tool_names is None, returns all tools.
        If tool_names is provided, returns only those tools.
        """
        if tool_names is None:
            tools = list(self._tools.values())
        else:
            tools = [self._tools[name] for name in tool_names if name in self._tools]

        return [tool_schema_to_openai_format(tool.schema) for tool in tools]

    @property
    def count(self) -> int:
        return len(self._tools)

    @property
    def names(self) -> list[str]:
        """Registered tool names (registration order)."""
        return list(self._tools.keys())
