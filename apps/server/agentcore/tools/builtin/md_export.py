"""md_export — deterministic Markdown → Word / PDF export into the workspace.

Shares ``agentcore.docs_export`` with the desktop workspace「导出 Word / PDF」HTTP
path. Never shells out to pandoc / Playwright / code_execute / LLM scripting.
"""

from __future__ import annotations

import time
from typing import Any, Literal

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.docs_export.layout import (
    DOC_LAYOUTS,
    LAYOUT_INVALID_MESSAGE,
    LAYOUT_PARAM_DESCRIPTION,
    LAYOUT_STANDARD,
    parse_layout,
)
from agentcore.docs_export.workspace_export import (
    ExportMarkdownError,
    export_markdown_path,
    export_markdown_to_pdf_path,
)
from agentcore.tools.file_products import file_product
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

MD_EXPORT_TOOL_NAME = "md_export"
ExportFormat = Literal["docx", "pdf"]
EXPORT_FORMATS: tuple[ExportFormat, ...] = ("docx", "pdf")
FORMAT_INVALID_MESSAGE = (
    f"format 须为 {' / '.join(EXPORT_FORMATS)}（无默认：Word 传 docx，PDF 传 pdf）。"
)


def parse_export_format(value: object) -> ExportFormat | None:
    token = str(value or "").strip().lower()
    if token == "docx":
        return "docx"
    if token == "pdf":
        return "pdf"
    return None


class MdExportTool:
    """Export a workspace Markdown file to a sibling ``.docx`` or ``.pdf``."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.SELF_REPORT,
        produces_formats=(".docx", ".pdf"),
        workspace_io=True,
        resident=False,
        catalog_summary="导出 Word 或 PDF",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=MD_EXPORT_TOOL_NAME,
            description=(
                "把工作区内的 Markdown 确定性导出为同目录同名 Word（.docx）或 PDF（.pdf）。"
                "覆盖标题、列表、表格、代码；Word 可嵌相对路径图片（缺图回执警告）；"
                "PDF 不嵌图、中文缺字体时回执警告。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区内的 Markdown 相对路径",
                    },
                    "format": {
                        "type": "string",
                        "enum": list(EXPORT_FORMATS),
                        "description": "docx=Word；pdf=PDF。",
                    },
                    "layout": {
                        "type": "string",
                        "enum": list(DOC_LAYOUTS),
                        "default": LAYOUT_STANDARD,
                        "description": LAYOUT_PARAM_DESCRIPTION,
                    },
                },
                "required": ["path", "format"],
            },
            face=ToolFace.FILE,
            approval=ToolApproval.GRANTABLE,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        rel_path = str(arguments.get("path") or "").strip()
        if not rel_path:
            return _fail("path 不能为空：请提供工作区内的 .md 相对路径", start)

        fmt = parse_export_format(arguments.get("format"))
        if fmt is None:
            return _fail(FORMAT_INVALID_MESSAGE, start)

        layout = parse_layout(arguments.get("layout"))
        if layout is None:
            return _fail(LAYOUT_INVALID_MESSAGE, start)

        try:
            if fmt == "docx":
                result = await export_markdown_path(
                    context.backend, rel_path, layout=layout
                )
            else:
                result = await export_markdown_to_pdf_path(
                    context.backend, rel_path, layout=layout
                )
        except ExportMarkdownError as e:
            return _fail(e.message, start)

        kind = "docx" if fmt == "docx" else "pdf"
        label = "Word" if fmt == "docx" else "PDF"
        logger.info(
            "md_export.exported",
            source=result.source_path,
            output=result.output_path,
            bytes=result.size_bytes,
            format=fmt,
            layout=layout,
            warnings=len(result.warnings),
            run_id=context.run_id,
        )

        lines = [
            f"已导出 {label}：{result.output_path}（{result.size_bytes} 字节）",
            "【artifact manifest】",
            f"path: {result.output_path}",
            f"kind: {kind}",
            f"bytes: {result.size_bytes}",
            f"source: {result.source_path}",
        ]
        if result.warnings:
            lines.append("warnings:")
            lines.extend(f"  - {w}" for w in result.warnings)
        else:
            lines.append("warnings: （无）")
        lines.append(f"【验真】请以本 manifest 确认落盘；可用工作区下载打开 .{kind}。")

        return ToolResult(
            tool_call_id="",
            success=True,
            output="\n".join(lines),
            duration_ms=int((time.monotonic() - start) * 1000),
            metadata={
                "path": result.output_path,
                "source": result.source_path,
                "bytes": result.size_bytes,
                "format": fmt,
                "warnings": list(result.warnings),
            },
            file_products=[
                file_product(result.output_path, derived_from=result.source_path)
            ],
        )


def _fail(error: str, start: float) -> ToolResult:
    return ToolResult(
        tool_call_id="",
        success=False,
        output="",
        error=error,
        duration_ms=int((time.monotonic() - start) * 1000),
    )
