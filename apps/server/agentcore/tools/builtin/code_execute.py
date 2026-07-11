"""Code execution tool — runs code in the workspace via ``ToolContext.backend``.

Thin shell: the backend (``ServerWorkspace`` today, ``LocalWorkspace`` later)
owns the ``SandboxProvider`` and sets the working directory to the workspace
root, so executed code sees the same files the file tools do.
"""

import time
from typing import Any, Literal

from agentcore.core.errors import SandboxError
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.sandbox.protocol import ExecutionRequest

_USAGE_TAIL = (
    "\n用法要点：① 优先用 language=python 或 javascript 直接运行内联代码，"
    "少用 bash 外壳——bash 在部分主机（如 Windows）可能不可用。② 代码的"
    "工作目录就是工作区根目录，访问工作区文件请用相对路径（如 fib.py），"
    "不要假设 /workspace 之类的绝对路径。③ 抓取网页或调用公开 HTTP API "
    "优先用 read_url / web_search 工具，不要在代码里发网络请求。"
)


def code_execute_description(location: Literal["server", "local"] | None = None) -> str:
    """Location-aware tool description (云端沙箱 vs 用户本机)."""
    if location == "local":
        where = (
            "在【用户本机】工作区目录中执行代码（支持 Python、JavaScript、Bash），"
            "可访问工作区内的文件。命令真实跑在用户机器上，除非确有必要，"
            "避免破坏性或不可逆的操作。"
        )
    elif location == "server":
        where = (
            "在【服务端云端沙箱】工作区目录中执行代码（支持 Python、JavaScript、Bash），"
            "可访问工作区内的文件。沙箱触达不了用户的电脑、本机应用与本机文件。"
        )
    else:
        # Catalog / unknown backend: stay honest without the old two-way hedge.
        where = (
            "在当前对话工作区目录中执行代码（支持 Python、JavaScript、Bash），"
            "可访问工作区内的文件。具体是云端沙箱还是用户本机，取决于本回合工作区绑定"
            "（见 `<workspace_context>`）。"
        )
    return where + _USAGE_TAIL


def _make_output_callback(context: ToolContext):
    """Forward sandbox output chunks via ``on_progress`` when a live sink is wired."""
    on_progress = context.on_progress
    if on_progress is None:
        return None

    def callback(stream: str, chunk: str) -> None:
        on_progress("output", {"stream": stream, "chunk": chunk})

    return callback


class CodeExecuteTool:
    """Execute code in the workspace environment for this turn's backend."""

    def __init__(self, *, location: Literal["server", "local"] | None = None) -> None:
        self._location = location

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="code_execute",
            description=code_execute_description(self._location),
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
                    "purpose": {
                        "type": "string",
                        "description": (
                            "一句话中文说明这段代码要做什么；会展示给用户作为审批说明，"
                            "执行时忽略"
                        ),
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
            on_output=_make_output_callback(context),
        )

        # 工具执行阶段进度 (联网前端展示优化): the sandbox run is the slow blocking leg —
        # signal「正在执行」so the waiting row is live. Best-effort; ``on_phase`` is None on
        # unscoped call sites (tests / evals).
        if context.on_phase:
            context.on_phase("executing")
        try:
            result = await context.backend.execute(request)
        except SandboxError as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            msg = e.message or str(e)
            return ToolResult(
                tool_call_id="",
                success=False,
                output=msg,
                error=msg,
                duration_ms=duration_ms,
            )
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

        # Render-oriented twin of ``output`` (工具结果富渲染): the client shows a
        # terminal-style view (stdout, stderr in red, exit-code badge) instead of
        # the flattened "stdout:\n…\nstderr:\n…" text. Kept structured so failures
        # (non-zero exit) surface stderr distinctly.
        display = {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.exit_code,
            "language": language,
        }
        return ToolResult(
            tool_call_id="",
            success=result.success,
            output=output,
            error=None if result.success else f"退出码 {result.exit_code}",
            duration_ms=duration_ms,
            display=display,
        )
