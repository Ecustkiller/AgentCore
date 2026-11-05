"""Project-native TypeScript / Python diagnostics through fixed commands."""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)
from agentcore.tools.sandbox.protocol import ExecutionRequest

_MAX_DIAGNOSTICS = 200
_TS_DIAGNOSTIC = re.compile(
    r"^(?P<path>.+?)\((?P<line>\d+),(?P<col>\d+)\): "
    r"(?P<severity>error|warning) (?P<code>TS\d+): (?P<message>.+)$"
)
_MYPY_DIAGNOSTIC = re.compile(
    r"^(?P<path>.+?):(?P<line>\d+)(?::(?P<col>\d+))?: "
    r"(?P<severity>error|warning|note): (?P<message>.+?)(?: \[(?P<code>[^\]]+)\])?$"
)

logger = get_logger(__name__)


@dataclass(frozen=True)
class _Diagnostic:
    path: str
    line: int
    col: int | None
    severity: str
    code: str
    message: str

    def render(self) -> str:
        col = f":{self.col}" if self.col is not None else ""
        code = f" [{self.code}]" if self.code else ""
        return (
            f"{self.path}:{self.line}{col}: "
            f"{self.severity}: {self.message}{code}"
        )


def _parse_diagnostics(output: str, *, language: str) -> list[_Diagnostic]:
    out: list[_Diagnostic] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        pattern = _TS_DIAGNOSTIC if language == "typescript" else _MYPY_DIAGNOSTIC
        match = pattern.match(line)
        if match is None:
            continue
        groups = match.groupdict()
        col = groups.get("col")
        out.append(
            _Diagnostic(
                path=groups["path"],
                line=int(groups["line"]),
                col=int(col) if col else None,
                severity=groups["severity"],
                code=groups.get("code") or "",
                message=groups["message"],
            )
        )
        if len(out) >= _MAX_DIAGNOSTICS:
            break
    return out


def _driver_code(*, language: str, target: str, timeout_seconds: int) -> str:
    return f"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

root = Path.cwd()
language = {language!r}
target = {target!r}
timeout_seconds = {timeout_seconds}

def emit(kind, **fields):
    print(json.dumps({{"kind": kind, **fields}}, ensure_ascii=False))

if language == "auto":
    if (root / "tsconfig.json").is_file() and (root / "node_modules/typescript/bin/tsc").is_file():
        language = "typescript"
    elif (root / "pyproject.toml").is_file():
        language = "python"

if language == "typescript":
    tsc = root / "node_modules/typescript/bin/tsc"
    node = shutil.which("node")
    if not tsc.is_file() or node is None:
        emit("unavailable", language="typescript", reason="未找到 node 或 node_modules/typescript")
        raise SystemExit(0)
    argv = [node, str(tsc), "--noEmit", "--pretty", "false", "--incremental", "false"]
    if target:
        argv.append(target)
elif language == "python":
    if importlib.util.find_spec("mypy") is None:
        emit("unavailable", language="python", reason="当前运行环境未安装 mypy")
        raise SystemExit(0)
    argv = [
        sys.executable, "-m", "mypy",
        "--config-file", os.devnull,
        "--no-color-output",
        "--show-column-numbers",
        "--no-error-summary",
        target or ".",
    ]
else:
    emit("unavailable", language=language, reason="未找到可识别的项目诊断配置")
    raise SystemExit(0)

try:
    proc = subprocess.run(
        argv,
        cwd=root,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
        check=False,
    )
except subprocess.TimeoutExpired:
    emit("timeout", language=language, command=argv, timeout_seconds=timeout_seconds)
    raise SystemExit(0)
emit(
    "completed",
    language=language,
    command=argv,
    exit_code=proc.returncode,
    output=(proc.stdout or "") + (proc.stderr or ""),
)
"""


class ProjectDiagnosticsTool:
    """Run project-native compilers without accepting arbitrary commands."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.NO_PRODUCT,
        workspace_io=True,
        execution_class=True,
        catalog_summary="跑项目级类型诊断",
        blurb="用 tsc 或 mypy 找类型错误",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="project_diagnostics",
            description=(
                "项目级诊断：优先运行工作区自带的 TypeScript tsc 或 Python mypy。"
                "固定无网络命令，不执行任意参数；不是常驻 LSP。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "language": {
                        "type": "string",
                        "enum": ["auto", "typescript", "python"],
                        "default": "auto",
                    },
                    "path": {
                        "type": "string",
                        "description": "可选的工作区相对文件或目录。",
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "minimum": 5,
                        "maximum": 300,
                        "default": 120,
                    },
                },
            },
            face=ToolFace.EXECUTION,
            approval=ToolApproval.GRANTABLE,
            timeout_seconds=320,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        language = str(arguments.get("language") or "auto").strip().lower()
        if language not in {"auto", "typescript", "python"}:
            return self._error("language 必须是 auto / typescript / python", start)
        target = str(arguments.get("path") or "").strip().replace("\\", "/")
        if target.startswith("/") or ".." in target.split("/"):
            return self._error("path 必须是工作区相对安全路径", start)
        timeout_seconds = max(
            5,
            min(int(arguments.get("timeout_seconds") or 120), 300),
        )
        cache_key = json.dumps(
            {
                "language": language,
                "path": target,
                "timeout_seconds": timeout_seconds,
            },
            sort_keys=True,
        )
        cached = context.get_cached_tool_result(
            kind="project_diagnostics",
            key=cache_key,
        )
        if isinstance(cached, ToolResult):
            context.note_tool_cache_saved_chars(len(cached.output or ""))
            metadata = dict(cached.metadata or {})
            metadata["turn_cache_hit"] = True
            logger.info(
                "project_diagnostics.completed",
                language=str(metadata.get("language") or language),
                source="cache",
                duration_ms=int((time.monotonic() - start) * 1000),
                diagnostics=int(metadata.get("diagnostics") or 0),
            )
            return replace(
                cached,
                duration_ms=int((time.monotonic() - start) * 1000),
                metadata=metadata,
            )
        request = ExecutionRequest(
            code=_driver_code(
                language=language,
                target=target,
                timeout_seconds=timeout_seconds,
            ),
            language="python",
            timeout_seconds=timeout_seconds + 10,
            memory_limit_mb=512,
            network_mode="none",
        )
        try:
            result = await context.backend.execute(request)
        except Exception as exc:  # noqa: BLE001 - execution boundary is typed above tools
            return self._error(f"诊断执行失败：{exc}", start)
        payload: dict[str, Any] | None = None
        for raw_line in result.stdout.splitlines():
            try:
                candidate = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get("kind"):
                payload = candidate
        if payload is None:
            detail = (result.stdout + "\n" + result.stderr).strip()
            return self._error(
                f"诊断器未返回结构化结果（exit={result.exit_code}）：{detail[:1000]}",
                start,
            )
        kind = str(payload.get("kind"))
        resolved_language = str(payload.get("language") or language)
        if kind == "unavailable":
            return self._error(str(payload.get("reason") or "诊断器不可用"), start)
        if kind == "timeout":
            return self._error(
                f"诊断超时（{payload.get('timeout_seconds')}s）",
                start,
            )
        output = str(payload.get("output") or "")
        diagnostics = _parse_diagnostics(output, language=resolved_language)
        lines = [diagnostic.render() for diagnostic in diagnostics]
        if not lines:
            lines = [
                "未发现可解析的类型诊断。"
                if int(payload.get("exit_code") or 0) == 0
                else output.strip()[:8000] or "诊断命令未通过，但未返回可解析错误。"
            ]
        final = ToolResult(
            tool_call_id="",
            success=True,
            output="\n".join(lines),
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=16000,
            metadata={
                "language": resolved_language,
                "provider": resolved_language,
                "diagnostics": len(diagnostics),
                "exit_code": int(payload.get("exit_code") or 0),
            },
        )
        logger.info(
            "project_diagnostics.completed",
            language=resolved_language,
            source="compiler",
            duration_ms=final.duration_ms,
            diagnostics=len(diagnostics),
            exit_code=int(payload.get("exit_code") or 0),
        )
        context.cache_tool_result(
            kind="project_diagnostics",
            key=cache_key,
            value=replace(final, metadata=dict(final.metadata or {})),
        )
        return final

    @staticmethod
    def _error(message: str, start: float) -> ToolResult:
        return ToolResult(
            tool_call_id="",
            success=False,
            output="",
            error=message,
            duration_ms=int((time.monotonic() - start) * 1000),
            contract_failure=True,
        )
