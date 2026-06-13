"""File operations tool (read, write, list).

All paths are restricted to the workspace directory to prevent path traversal attacks.
"""

import os
import time
from pathlib import Path
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema


def _resolve_safe_path(workspace: Path, relative_path: str) -> Path | None:
    """Resolve a path safely within the workspace. Returns None if path escapes."""
    try:
        resolved = (workspace / relative_path).resolve()
        if not str(resolved).startswith(str(workspace.resolve())):
            return None
        return resolved
    except (ValueError, OSError):
        return None


class FileReadTool:
    """Read the contents of a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_read",
            description="Read the contents of a file. Path must be relative to the workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative file path within the workspace",
                    },
                },
                "required": ["path"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")

        safe_path = _resolve_safe_path(context.workspace_dir, rel_path)
        if safe_path is None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Path '{rel_path}' is outside the workspace",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        if not safe_path.exists():
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"File not found: {rel_path}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        if not safe_path.is_file():
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Not a file: {rel_path}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        try:
            content = safe_path.read_text(encoding="utf-8")
            return ToolResult(
                tool_call_id="",
                success=True,
                output=content,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Failed to read file: {e}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )


class FileWriteTool:
    """Write content to a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_write",
            description=(
                "Write content to a file. Creates parent directories if needed. "
                "Path must be relative to workspace."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative file path within the workspace",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file",
                    },
                },
                "required": ["path", "content"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        content = arguments.get("content", "")

        safe_path = _resolve_safe_path(context.workspace_dir, rel_path)
        if safe_path is None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Path '{rel_path}' is outside the workspace",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        try:
            safe_path.parent.mkdir(parents=True, exist_ok=True)
            safe_path.write_text(content, encoding="utf-8")
            return ToolResult(
                tool_call_id="",
                success=True,
                output=f"Written {len(content)} bytes to {rel_path}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Failed to write file: {e}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )


class FileListTool:
    """List files in a directory within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_list",
            description="List files and directories. Path must be relative to workspace.",
            parameters={
                "type": "object",
                "properties": {
                    "directory": {
                        "type": "string",
                        "description": "Relative directory path (default: workspace root)",
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to filter results (e.g. '*.py')",
                        "default": "*",
                    },
                },
                "required": [],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        directory = arguments.get("directory", ".")
        pattern = arguments.get("pattern", "*")

        safe_path = _resolve_safe_path(context.workspace_dir, directory)
        if safe_path is None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Path '{directory}' is outside the workspace",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        if not safe_path.is_dir():
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Not a directory: {directory}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        try:
            entries = sorted(safe_path.glob(pattern))[:100]  # cap at 100 entries
            lines = []
            for entry in entries:
                rel = os.path.relpath(entry, context.workspace_dir)
                prefix = "d " if entry.is_dir() else "f "
                lines.append(f"{prefix}{rel}")

            output = "\n".join(lines) if lines else "(empty directory)"
            return ToolResult(
                tool_call_id="",
                success=True,
                output=output,
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        except Exception as e:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Failed to list directory: {e}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )
