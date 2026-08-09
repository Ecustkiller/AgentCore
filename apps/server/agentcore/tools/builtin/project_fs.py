"""CEO-only read-only cross-desk tools: list / read a registered Folder.

Per-call ``folder_id`` → ``load_target_folder_binding`` + ``build_target_backend``
(WorkspaceChannel for local). Does **not** rewrite session ``folder_id``, and does
**not** call ``apply_target_desktop`` (no target-desk memory rewrite).

Write / heavy work stays on ``delegate`` + ``target_folder_id``. Generic ``file_*``
stay birth-desk only (no ``target_folder_id`` param).
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.runtime.delegate.target_desktop import (
    TargetDesktopError,
    build_target_backend,
    load_target_folder_binding,
)
from agentcore.runtime.events import EventSink
from agentcore.tools.builtin.file_ops.read import FileListTool, FileReadTool
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)
from agentcore.workspace.locate import workspace_channel_for_tools

logger = get_logger(__name__)

LIST_PROJECT_DIR_TOOL_NAME = "list_project_dir"
READ_PROJECT_FILE_TOOL_NAME = "read_project_file"

_MISSING_FOLDER_ID = "缺少 folder_id（目标项目 id；先 list_projects / resolve_project）。"
_DENIED_MSG = (
    "目标项目 `{folder_id}` 不存在或无权访问；请重新列/解析项目后再读。"
)
_LOCAL_CHANNEL_MSG = (
    "目标项目为本地目录，但本回合无可用桌面工作区通道；"
    "请确认桌面在线后再用只读跨桌，或改用 delegate(target_folder_id=…) 派工。"
)


def _event_sink_from_context(context: ToolContext) -> EventSink | None:
    """Reuse the turn's SSE sink so local WorkspaceChannel ops share the bridge."""
    for holder in (context.workspace_channel, context.desktop_channel):
        if holder is None:
            continue
        sink = getattr(holder, "sink", None)
        if isinstance(sink, EventSink):
            return sink
    return None


async def _open_target_desk(
    *,
    folder_id: str,
    context: ToolContext,
) -> tuple[ToolContext | None, ToolResult | None]:
    """Bind a per-call target backend; never mutates session desk / memory.

    Returns ``(target_ctx, None)`` on success, or ``(None, error_result)`` on failure.
    """
    cleaned = folder_id.strip()
    if not cleaned:
        return None, ToolResult(
            tool_call_id="",
            success=False,
            output=_MISSING_FOLDER_ID,
            error="missing folder_id",
        )

    try:
        binding = await load_target_folder_binding(
            folder_id=cleaned,
            user_id=context.user_id,
        )
    except TargetDesktopError as e:
        logger.warning(
            "project_fs.bind_failed",
            folder_id=cleaned,
            user_id=context.user_id,
            error=e.message,
        )
        return None, ToolResult(
            tool_call_id="",
            success=False,
            output=e.message,
            error="target_desktop_error",
        )

    if binding is None:
        msg = _DENIED_MSG.format(folder_id=cleaned)
        return None, ToolResult(
            tool_call_id="",
            success=False,
            output=msg,
            error="folder_denied",
        )

    sink = _event_sink_from_context(context)
    if binding.local_binding is not None and sink is None:
        return None, ToolResult(
            tool_call_id="",
            success=False,
            output=_LOCAL_CHANNEL_MSG,
            error="workspace_channel_unavailable",
        )
    if sink is None:
        # Cloud Folder: ServerWorkspace ignores sink; keep a throwaway for the API.
        sink = EventSink()

    backend = build_target_backend(
        user_id=context.user_id,
        folder_id=binding.folder_id,
        conversation_id=context.conversation_id,
        sink=sink,
        local_binding=binding.local_binding,
    )
    workspace_channel = workspace_channel_for_tools(
        backend,
        sink=sink,
        conversation_id=context.conversation_id,
    )
    # Ephemeral desk: do not share birth-desk file_read ceilings / materials;
    # do not rewrite context.backend (session mount stays put).
    target_ctx = replace(
        context,
        backend=backend,
        workspace_channel=workspace_channel,
        shared_workspace=True,
        material_paths=frozenset(),
        file_read_counts={},
        file_read_reread_remaining={},
        file_read_verbatim_paths=None,
    )
    logger.info(
        "project_fs.target_opened",
        folder_id=binding.folder_id,
        folder_name=binding.name,
        location=getattr(backend, "location", None),
        local=bool(binding.local_binding),
        run_id=context.run_id,
        conversation_untouched=True,
    )
    return target_ctx, None


def _readonly_args(arguments: dict[str, Any]) -> dict[str, Any]:
    """Drop ``folder_id`` before delegating to birth-desk file_* implementations."""
    return {k: v for k, v in arguments.items() if k != "folder_id"}


class ListProjectDirTool:
    """CEO-only: list a directory on a registered Folder desk (read-only)."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=LIST_PROJECT_DIR_TOOL_NAME,
            description=(
                "只读跨桌：列出【已登记项目】某目录下的文件/子目录（参数含 folder_id）。"
                "按次指定目标，不改本会话 conversation.folder_id / 出生桌，不写目标桌记忆。"
                "通用 file_list 只绑出生桌；写盘/重活请 delegate(target_folder_id=…)。"
                "folder_id 来自 list_projects / resolve_project / create_project。"
                "失败语义同目标桌绑定：无权/不存在、库不可达、本地通道问题。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "folder_id": {
                        "type": "string",
                        "description": "目标项目 Folder id（账号名册已登记）。",
                    },
                    "directory": {
                        "type": "string",
                        "description": (
                            "相对该项目工作区根的 POSIX 目录（默认 `.`；"
                            "`/<根标签>/…` 与裸 `/`、`\\` 视为根；其它绝对路径拒绝）"
                        ),
                        "default": ".",
                    },
                    "pattern": {
                        "type": "string",
                        "description": (
                            "过滤 glob（如 '*.py'、'*.{ts,tsx}'）。"
                            "非递归时只匹配当前层文件名。"
                        ),
                        "default": "*",
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "递归列出子目录（树形）。默认 false。",
                        "default": False,
                    },
                    "max_depth": {
                        "type": "integer",
                        "description": "递归最大深度（仅 recursive=true）。默认 3，上限 8。",
                        "default": 3,
                        "minimum": 1,
                        "maximum": 8,
                    },
                },
                "required": ["folder_id"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        folder_id = str(arguments.get("folder_id") or "")
        target_ctx, err = await _open_target_desk(folder_id=folder_id, context=context)
        if err is not None:
            return err
        assert target_ctx is not None
        return await FileListTool().execute(_readonly_args(arguments), target_ctx)


class ReadProjectFileTool:
    """CEO-only: read a file on a registered Folder desk (read-only)."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.ALWAYS,
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=READ_PROJECT_FILE_TOOL_NAME,
            description=(
                "只读跨桌：读取【已登记项目】内某文件（参数含 folder_id + path）。"
                "按次指定目标，不改本会话归属/出生桌，不写目标桌记忆。"
                "通用 file_read 只绑出生桌；写盘/重活请 delegate(target_folder_id=…)。"
                "支持 offset/limit 行窗；Office/PDF 透明抽文本规则同 file_read。"
                "失败语义同目标桌绑定：无权/不存在、库不可达、本地通道问题。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "folder_id": {
                        "type": "string",
                        "description": "目标项目 Folder id（账号名册已登记）。",
                    },
                    "path": {
                        "type": "string",
                        "description": (
                            "相对该项目工作区根的 POSIX 文件路径（`.`=根；"
                            "`/<根标签>/…` 与裸 `/`、`\\` 视为根；其它绝对路径拒绝）"
                        ),
                    },
                    "offset": {
                        "type": "integer",
                        "description": "起始行号（1-based，含）。省略则从第 1 行开始。",
                        "minimum": 1,
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多读取行数。省略则默认窗口 500 行。",
                        "minimum": 1,
                        "maximum": 500,
                    },
                },
                "required": ["folder_id", "path"],
            },
            category=ToolCategory.ORCHESTRATION,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        folder_id = str(arguments.get("folder_id") or "")
        target_ctx, err = await _open_target_desk(folder_id=folder_id, context=context)
        if err is not None:
            return err
        assert target_ctx is not None
        return await FileReadTool().execute(_readonly_args(arguments), target_ctx)
