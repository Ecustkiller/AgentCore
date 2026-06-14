"""Built-in tool implementations."""

from agentcore.tools.builtin.code_execute import CodeExecuteTool
from agentcore.tools.builtin.file_ops import (
    FileListTool,
    FileReadTool,
    FileWriteTool,
    StrReplaceTool,
)
from agentcore.tools.builtin.grep import GrepTool
from agentcore.tools.builtin.web.read_url import ReadUrlTool
from agentcore.tools.builtin.web.search import WebSearchTool
from agentcore.tools.registry import ToolRegistry


def build_builtin_registry() -> ToolRegistry:
    """Register the platform's built-in tools (single source of truth).

    Both the chat pipeline (worker toolset) and the read-only ``GET /tools``
    catalog build from this. The CEO-only ``delegate`` orchestration primitive is
    intentionally excluded — it is wired separately in ``runtime.pipeline`` and is
    not a general-purpose capability a worker (or the catalog) should advertise.
    """
    registry = ToolRegistry()
    registry.register(WebSearchTool())
    registry.register(ReadUrlTool())
    registry.register(FileReadTool())
    registry.register(FileWriteTool())
    registry.register(StrReplaceTool())
    registry.register(FileListTool())
    registry.register(GrepTool())
    registry.register(CodeExecuteTool())
    return registry
