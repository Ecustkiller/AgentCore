"""Code execution tool — runs code in the workspace via ``ToolContext.backend``.

Thin shell: the backend (``ServerWorkspace`` today, ``LocalWorkspace`` later)
owns the ``SandboxProvider`` and sets the working directory to the workspace
root, so executed code sees the same files the file tools do.
"""

import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.sandbox.protocol import ExecutionRequest


class CodeExecuteTool:
    """Execute code in a sandboxed environment."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="code_execute",
            description=(
                "在工作区目录中执行代码（支持 Python、JavaScript、Bash），可访问"
                "工作区内的文件。视工作区模式而定，它可能【直接运行在用户自己的"
                "机器上】（本地模式），而非服务器沙箱；因此除非确有必要，避免执行"
                "破坏性或不可逆的命令。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "code": {
                        "type": "string",
                        "description": "要执行的代码",
                    },
                    "language": {
                        "type": "string",
                        "enum": ["python", "javascript", "bash"],
                        "description": "编程语言",
                        "default": "python",
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "最长执行时间（秒）",
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
                error="缺少必填参数：code",
                duration_ms=0,
            )

        request = ExecutionRequest(
            code=code,
            language=language,
            timeout_seconds=timeout,
        )

        result = await context.backend.execute(request)
        duration_ms = int((time.monotonic() - start) * 1000)

        output_parts = []
        if result.stdout:
            output_parts.append(f"stdout:\n{result.stdout}")
        if result.stderr:
            output_parts.append(f"stderr:\n{result.stderr}")
        if not output_parts:
            output_parts.append("（无输出）")

        output = "\n".join(output_parts)
        if result.exit_code != 0:
            output += f"\n\n退出码：{result.exit_code}"

        return ToolResult(
            tool_call_id="",
            success=result.success,
            output=output,
            error=None if result.success else f"退出码 {result.exit_code}",
            duration_ms=duration_ms,
        )
