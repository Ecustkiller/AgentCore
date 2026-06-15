"""Tool Protocol, ToolBinding, and approval three-state.

Defines the unified contract for all tools (built-in and external).
Tools declare their schema (for LLM function calling) and implement execute().
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Protocol

from agentcore.core.types import ToolApproval, ToolCategory, ToolEffect

if TYPE_CHECKING:
    from agentcore.workspace.protocol import WorkspaceBackend


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
    run_id: str
    agent_id: str
    backend: WorkspaceBackend
    user_id: str


@dataclass
class ToolResult:
    """Result of a tool execution.

    ``effect`` steers the ReAct loop and is the ONLY signal the engine acts on to
    decide whether the turn continues — never the tool's name or category (引擎纯化,
    设计 §18.5). The default ``ToolEffect.CONTINUE`` feeds ``output`` back to the
    model and loops; a terminal effect (``HANDOFF`` / ``INTERACT``) stops the loop
    because the tool already produced the turn's final user-facing answer, carried
    in ``final_text`` (so the model does not generate a second, duplicate reply).
    The CEO ``ask_user`` checkpoint sets ``INTERACT`` on a "stop" decision — its
    closing note is the ``final_text`` — so the turn ends gracefully in-band rather
    than via an SSE abort; ``delegate`` stays ``CONTINUE`` (its workers' products
    return to the CEO loop). ``final_text`` is persisted but NOT re-emitted and is
    exempt from ``output`` truncation (which only guards the model-facing
    ``output`` string).

    ``output_limit`` overrides the default model-facing truncation budget for the
    ``output`` string. Most tools leave it ``None`` (4000 chars); read-heavy tools
    (e.g. ``read_url``) raise it so a full page body is not truncated into invalid
    JSON. ``final_text`` is never subject to this cap.

    ``citations`` carries structured web sources a tool consulted (each a
    ``{url, title, snippet, site}`` dict). Research tools (``web_search`` /
    ``read_url``) populate it so the engine can aggregate per-turn sources and the
    client can render source cards under the answer; non-web tools leave it
    ``None``. The dicts themselves are UI metadata; the engine additionally
    assigns each source a canonical number (its card index) and folds *that
    number* back into the tool's model-facing output, so the model can cite by a
    card-aligned number (see ``engine._annotate_tool_citations``).
    """

    tool_call_id: str
    success: bool
    output: str
    error: str | None = None
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    effect: ToolEffect = ToolEffect.CONTINUE
    final_text: str | None = None
    output_limit: int | None = None
    citations: list[dict[str, Any]] | None = None

    _MAX_OUTPUT_LEN = 4000

    @property
    def is_terminal(self) -> bool:
        """Whether this result ends the turn (any non-``CONTINUE`` effect)."""
        return self.effect is not ToolEffect.CONTINUE

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
