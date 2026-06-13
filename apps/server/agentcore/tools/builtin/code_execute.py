"""Code execution tool that delegates to the SandboxProvider."""

import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.sandbox.protocol import ExecutionRequest
from agentcore.tools.sandbox.subprocess import SubprocessSandbox


class CodeExecuteTool:
    """Execute code in a sandboxed environment."""

    def __init__(self, sandbox: SubprocessSandbox | None = None):
        self._sandbox = sandbox or SubprocessSandbox()

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="code_execute",
            description=(
                "Execute code in a sandboxed environment. "
                "Supports Python, JavaScript, and Bash."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "The code to execute",
                    },
                    "language": {
                        "type": "string",
                        "enum": ["python", "javascript", "bash"],
                        "description": "Programming language",
                        "default": "python",
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "Maximum execution time in seconds",
                        "default": 30,
                    },
                },
                "required": ["code"],
            },
            category=ToolCategory.EXECUTION,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        code = arguments.get("code", "")
        language = arguments.get("language", "python")
        timeout = min(arguments.get("timeout_seconds", 30), 60)  # cap at 60s

        if not code.strip():
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="Code parameter is required",
                duration_ms=0,
            )

        request = ExecutionRequest(
            code=code,
            language=language,
            timeout_seconds=timeout,
        )

        result = await self._sandbox.execute(request)
        duration_ms = int((time.monotonic() - start) * 1000)

        output_parts = []
        if result.stdout:
            output_parts.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"stderr:\n{result.stderr}")
        if not output_parts:
            output_parts.append("(no output)")

        output = "\n".join(output_parts)
        if result.exit_code != 0:
            output += f"\n\nExit code: {result.exit_code}"

        return ToolResult(
            tool_call_id="",
            success=result.success,
            output=output,
            error=None if result.success else f"Exit code {result.exit_code}",
            duration_ms=duration_ms,
        )
