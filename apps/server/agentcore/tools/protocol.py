"""Tool Protocol, ToolBinding, and approval three-state.

Defines the unified contract for all tools (built-in and external).
Tools declare their schema (for LLM function calling) and implement execute().
"""

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from agentcore.core.types import ToolApproval, ToolCategory


@dataclass(frozen=True)
class ToolSchema:
    """Tool metadata declaration for LLM function calling."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema format
    category: ToolCategory
    approval: ToolApproval = ToolApproval.NEVER


@dataclass
class ToolContext:
    """Context provided to tools during execution."""

    execution_id: str
    step_id: str
    agent_id: str
    workspace_dir: Path
    user_id: str


@dataclass
class ToolResult:
    """Result of a tool execution.

    ``terminal`` marks a *handoff* tool: one that has already produced and
    streamed the turn's final user-facing answer itself (e.g. ``assemble_team``
    runs a multi-agent DAG whose synthesizer streams the answer). When set, the
    ReAct loop stops immediately instead of letting the calling model generate a
    second, duplicate reply. ``terminal_content`` carries that already-streamed
    answer back up the stack so it can be persisted (it is NOT re-emitted and is
    exempt from ``output`` truncation, which only guards the model-facing
    ``output`` string).

    ``output_limit`` overrides the default model-facing truncation budget for the
    ``output`` string. Most tools leave it ``None`` (4000 chars); read-heavy tools
    (e.g. ``read_url``) raise it so a full page body is not truncated into invalid
    JSON. ``terminal_content`` is never subject to this cap.
    """

    tool_call_id: str
    success: bool
    output: str
    error: str | None = None
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    terminal: bool = False
    terminal_content: str | None = None
    output_limit: int | None = None

    _MAX_OUTPUT_LEN = 4000

    def __post_init__(self):
        limit = self.output_limit if self.output_limit is not None else self._MAX_OUTPUT_LEN
        if len(self.output) > limit:
            self.output = self.output[:limit] + "\n... [output truncated]"


class Tool(Protocol):
    """Unified protocol for tool implementations."""

    @property
    def schema(self) -> ToolSchema:
        """Return tool metadata (name, description, parameters JSON Schema)."""
        ...

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        """Execute the tool with given arguments and context."""
        ...


def tool_schema_to_openai_format(schema: ToolSchema) -> dict:
    """Convert a ToolSchema to the OpenAI function calling format."""
    return {
        "type": "function",
        "function": {
            "name": schema.name,
            "description": schema.description,
            "parameters": schema.parameters,
        },
    }
