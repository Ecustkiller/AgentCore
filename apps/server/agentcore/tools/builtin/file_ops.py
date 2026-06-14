"""File operations tools (read, write, list, precise str_replace edit).

Thin shells over ``ToolContext.backend``: each tool parses arguments, calls the
workspace backend, maps typed ``WorkspaceError`` failures back to user-facing
messages, and renders a ``ToolResult``. All actual I/O and the path-traversal
guard live in the backend, so the same tools run unchanged against a server or a
local (desktop) workspace.
"""

import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.workspace.protocol import (
    AmbiguousMatch,
    NoMatch,
    NotADirectory,
    NotAFile,
    NotUTF8,
    OutsideWorkspace,
    PathNotFound,
    WorkspaceError,
)


def _error(error: str, start: float) -> ToolResult:
    """Build a failed ToolResult with elapsed timing."""
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
    )


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

        try:
            content = await context.backend.read(rel_path)
        except OutsideWorkspace:
            return _error(f"Path '{rel_path}' is outside the workspace", start)
        except PathNotFound:
            return _error(f"File not found: {rel_path}", start)
        except NotAFile:
            return _error(f"Not a file: {rel_path}", start)
        except WorkspaceError as e:
            return _error(f"Failed to read file: {e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            output=content,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class FileWriteTool:
    """Write content to a file within the workspace."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="file_write",
            description=(
                "Write content to a file, creating it (and any parent directories) "
                "or OVERWRITING it wholesale. Use this to create new files. To change "
                "part of an existing file, prefer str_replace, which edits only the "
                "matched span instead of rewriting everything. Path must be relative "
                "to the workspace."
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

        try:
            written = await context.backend.write(rel_path, content)
        except OutsideWorkspace:
            return _error(f"Path '{rel_path}' is outside the workspace", start)
        except WorkspaceError as e:
            return _error(f"Failed to write file: {e}", start)

        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"Written {written} bytes to {rel_path}",
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

        try:
            entries = await context.backend.list(directory, pattern)
        except OutsideWorkspace:
            return _error(f"Path '{directory}' is outside the workspace", start)
        except NotADirectory:
            return _error(f"Not a directory: {directory}", start)
        except WorkspaceError as e:
            return _error(f"Failed to list directory: {e}", start)

        lines = [f"{'d ' if entry.is_dir else 'f '}{entry.path}" for entry in entries]
        output = "\n".join(lines) if lines else "(empty directory)"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
        )


class StrReplaceTool:
    """Replace an exact text span in an existing workspace file (precise edit)."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="str_replace",
            description=(
                "Edit an existing file by replacing an EXACT text span. Prefer this "
                "over file_write when changing a file: it rewrites only the matched "
                "span, so it is safe for large files and won't clobber unrelated "
                "content. Put enough surrounding context in old_string to match "
                "EXACTLY ONCE, including whitespace, indentation, and line breaks. "
                "Fails if old_string is absent, or matches more than once unless "
                "replace_all is true. To create a new file, use file_write instead."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative file path within the workspace",
                    },
                    "old_string": {
                        "type": "string",
                        "description": (
                            "Exact text to replace, with enough surrounding context "
                            "to be unique in the file."
                        ),
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text (must differ from old_string).",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": (
                            "Replace every occurrence instead of requiring a single "
                            "unique match (default false)."
                        ),
                        "default": False,
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = arguments.get("path", "")
        old_string = arguments.get("old_string", "")
        new_string = arguments.get("new_string", "")
        replace_all = bool(arguments.get("replace_all", False))

        if not old_string:
            return _error("old_string must not be empty", start)
        if old_string == new_string:
            return _error(
                "old_string and new_string are identical; nothing to change", start
            )

        try:
            outcome = await context.backend.replace(
                rel_path, old_string, new_string, all_=replace_all
            )
        except OutsideWorkspace:
            return _error(f"Path '{rel_path}' is outside the workspace", start)
        except PathNotFound:
            return _error(f"File not found: {rel_path}", start)
        except NotAFile:
            return _error(f"Not a file: {rel_path}", start)
        except NotUTF8:
            return _error(f"Cannot edit a binary / non-UTF-8 file: {rel_path}", start)
        except NoMatch:
            return _error(
                f"old_string not found in {rel_path}; it must match the file "
                "exactly, including whitespace and indentation.",
                start,
            )
        except AmbiguousMatch as e:
            return _error(
                f"old_string is not unique in {rel_path} ({e.count} matches). Add "
                "more surrounding context to target a single span, or set "
                "replace_all=true.",
                start,
            )
        except WorkspaceError as e:
            return _error(f"Failed to write file: {e}", start)

        loc = "" if outcome.first_line is None else f" (around line {outcome.first_line})"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"Replaced {outcome.count} occurrence(s) in {rel_path}{loc}",
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={"replacements": outcome.count},
        )
