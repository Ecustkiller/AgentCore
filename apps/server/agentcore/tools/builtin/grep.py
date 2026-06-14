"""Built-in tool: grep — regex search over workspace file CONTENTS.

Complements the rest of the file family: ``file_list`` finds files by NAME and
``file_read`` opens one file, while ``grep`` finds WHERE a string / symbol /
pattern appears across many files, returning ripgrep-style ``path:line: text``
hits the model can then open with ``file_read``.

Thin shell over ``ToolContext.backend``: this tool validates the regex, builds a
``GrepQuery``, and renders the bounded ``GrepResult`` the backend returns. The
actual walk (ignore-dir pruning, size caps, binary filter, match caps) lives in
the backend so it runs identically against a server or local workspace.
"""

import re
import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.workspace.protocol import (
    GrepQuery,
    GrepResult,
    NotADirectory,
    OutsideWorkspace,
    PathNotFound,
    WorkspaceError,
)

_DEFAULT_MAX_RESULTS = 50
_MAX_RESULTS_CAP = 200
# grep output is line-oriented and denser than the 4000-char default; lift it so
# a full (already capped) result set is never truncated into a partial last line.
_OUTPUT_LIMIT = 16000


class GrepTool:
    """Search file CONTENTS across the workspace by regular expression."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="grep",
            description=(
                "Search file CONTENTS across the workspace using a regular "
                "expression (Python `re` syntax, like ripgrep). Use this to find "
                "WHERE a symbol, function, string, or any text appears — it returns "
                "matching lines as `path:line: text`. Then open the surrounding "
                "code with `file_read`. To find files BY NAME use `file_list` "
                "instead. Skips binary files and noise dirs (.git, node_modules, "
                "caches). Narrow with `path` and/or `glob` for faster, sharper hits."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for (Python re syntax).",
                    },
                    "path": {
                        "type": "string",
                        "description": (
                            "Relative directory to search within "
                            "(default: workspace root)."
                        ),
                        "default": ".",
                    },
                    "glob": {
                        "type": "string",
                        "description": (
                            "Optional filter on file NAME, e.g. '*.py' or '*.ts'. "
                            "A leading '**/' or directory prefix is ignored; only "
                            "the file name is matched."
                        ),
                    },
                    "case_insensitive": {
                        "type": "boolean",
                        "description": "Case-insensitive match (default false).",
                        "default": False,
                    },
                    "files_only": {
                        "type": "boolean",
                        "description": (
                            "Return only the list of matching files with per-file "
                            "match counts, not the matching lines (default false)."
                        ),
                        "default": False,
                    },
                    "max_results": {
                        "type": "integer",
                        "description": (
                            "Max matching lines (or files, in files_only mode) to "
                            "return. Default 50, max 200."
                        ),
                    },
                },
                "required": ["pattern"],
            },
            category=ToolCategory.FILESYSTEM,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()

        pattern = arguments.get("pattern") or ""
        if not pattern:
            return _fail("缺少必填参数：pattern", start)

        flags = re.IGNORECASE if arguments.get("case_insensitive") else 0
        try:
            re.compile(pattern, flags)
        except re.error as e:
            return _fail(f"正则表达式无效：{e}", start)

        rel_dir = arguments.get("path") or "."
        files_only = bool(arguments.get("files_only", False))
        try:
            raw = int(arguments.get("max_results", _DEFAULT_MAX_RESULTS))
            max_results = max(1, min(raw, _MAX_RESULTS_CAP))
        except (TypeError, ValueError):
            max_results = _DEFAULT_MAX_RESULTS

        query = GrepQuery(
            pattern=pattern,
            directory=rel_dir,
            glob=arguments.get("glob") or None,
            case_insensitive=bool(arguments.get("case_insensitive")),
            files_only=files_only,
            max_results=max_results,
        )

        try:
            result = await context.backend.grep(query)
        except OutsideWorkspace:
            return _fail(f"Path '{rel_dir}' is outside the workspace", start)
        except PathNotFound:
            return _fail(f"Directory not found: {rel_dir}", start)
        except NotADirectory:
            return _fail(f"Not a directory: {rel_dir}", start)
        except WorkspaceError as e:
            return _fail(f"Failed to search: {e}", start)

        output = _render(
            pattern=pattern,
            rel_dir=rel_dir,
            glob=arguments.get("glob") or "",
            result=result,
            files_only=files_only,
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=_OUTPUT_LIMIT,
            metadata={
                "match_count": result.total_matches,
                "file_count": len(result.file_counts),
            },
        )


def _fail(error: str, start: float) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
    )


def _render(
    *,
    pattern: str,
    rel_dir: str,
    glob: str,
    result: GrepResult,
    files_only: bool,
) -> str:
    if files_only:
        lines = [f"{rel}: {count}" for rel, count in result.file_counts]
        summary = f"{len(result.file_counts)} file(s) matched /{pattern}/"
    else:
        lines = [f"{h.path}:{h.line_no}: {h.text}" for h in result.hits]
        summary = (
            f"{result.total_matches} match(es) in "
            f"{len(result.file_counts)} file(s) for /{pattern}/"
        )

    if not lines:
        scope = "" if rel_dir in ("", ".") else f" under '{rel_dir}'"
        glob_note = f" in files matching '{glob}'" if glob else ""
        return f"No matches for /{pattern}/{scope}{glob_note}."

    body = "\n".join(lines)
    if result.truncated:
        body += "\n[results truncated — narrow the path/glob or refine the pattern]"
    return f"{summary}\n{body}"
