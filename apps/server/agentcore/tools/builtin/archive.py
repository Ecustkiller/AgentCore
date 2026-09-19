"""archive — workspace zip extract / create (single tool, ``action`` discriminator)."""

from __future__ import annotations

import time
from typing import Any

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.tools.builtin.archive_create import run_create
from agentcore.tools.builtin.archive_extract import run_extract
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)

ARCHIVE_TOOL_NAME = "archive"
_ACTION_EXTRACT = "extract"
_ACTION_CREATE = "create"
_ALLOWED_ACTIONS = frozenset({_ACTION_EXTRACT, _ACTION_CREATE})


class ArchiveTool:
    """Extract or pack a workspace zip."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.SELF_REPORT,
        workspace_io=True,
        resident=False,
        catalog_summary="工作区 zip 解压或打包",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=ARCHIVE_TOOL_NAME,
            description=(
                "工作区 zip 解压或打包到指定相对路径。大包持久落盘请用本工具。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": [_ACTION_EXTRACT, _ACTION_CREATE],
                        "description": "extract 解压；create 打包。",
                    },
                    "archive": {
                        "type": "string",
                        "description": "extract：工作区内的 zip 相对路径。",
                    },
                    "sources": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "create：要打包的工作区相对路径。",
                    },
                    "dest": {
                        "type": "string",
                        "description": (
                            "extract 目标目录（`.`=工作区根）；"
                            "create 目标 `.zip` 相对路径。"
                        ),
                    },
                },
                "required": ["action"],
            },
            face=ToolFace.FILE,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        action = str(arguments.get("action") or "").strip()
        if action == _ACTION_EXTRACT:
            return await run_extract(arguments, context)
        if action == _ACTION_CREATE:
            return await run_create(arguments, context)
        start = time.monotonic()
        if not action:
            error = "action 为必填（extract / create）。"
        else:
            error = f"action `{action}` 不在允许列表（extract / create）。"
        return ToolResult(
            tool_call_id="",
            success=False,
            output="",
            error=error,
            duration_ms=int((time.monotonic() - start) * 1000),
        )
