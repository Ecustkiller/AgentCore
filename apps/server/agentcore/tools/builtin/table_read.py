"""table_read — filter / sort the bound table (server DB, cap 200 rows)."""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.table.constants import READ_ROW_CAP, TABLE_UNBOUND
from agentcore.table.read import format_cell, query_rows, row_summary
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

TABLE_READ_TOOL_NAME = "table_read"
_NO_TABLE = f"table_read：{TABLE_UNBOUND}"


class TableReadTool:
    """Query the bound table snapshot for the CEO."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.TABLE,
        resident=False,
        catalog_summary="读当前表格",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=TABLE_READ_TOOL_NAME,
            description=(
                "按筛选/排序读取当前表格（最多 200 行）。仅表格会话可用。"
                "本回合若已有 <表格> 选区则不必再读选中行；要按条件扫表时用本工具。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "filters": {
                        "type": "array",
                        "description": "筛选条件（column_id / op / value）。",
                        "items": {"type": "object"},
                    },
                    "sort": {
                        "type": "object",
                        "description": "排序：column_id + dir(asc|desc)。",
                    },
                    "limit": {
                        "type": "integer",
                        "description": f"返回行数上限，最大 {READ_ROW_CAP}。",
                    },
                },
            },
            face=ToolFace.TABLE,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        table_id = context.table_id
        if not table_id:
            return ToolResult(
                tool_call_id="", success=False, output="", error=_NO_TABLE
            )
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories.tables import TableRepository

        filters = arguments.get("filters")
        if not isinstance(filters, list):
            filters = None
        sort = arguments.get("sort")
        if not isinstance(sort, dict):
            sort = None
        try:
            limit = int(arguments.get("limit") or READ_ROW_CAP)
        except (TypeError, ValueError):
            limit = READ_ROW_CAP
        async with async_session_factory() as session:
            state = await TableRepository(session).get_state(
                table_id, user_id=context.user_id
            )
        if state is None:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="表格不存在或无权访问。",
            )
        rows = query_rows(state, filters=filters, sort=sort, limit=limit)
        logger.info(
            "table.read",
            run_id=context.run_id,
            table_id=table_id,
            row_count=len(rows),
        )
        return ToolResult(
            tool_call_id="",
            success=True,
            output=_format(state, rows),
        )


def _format(state: Any, rows: list[dict[str, Any]]) -> str:
    cols = state.columns
    lines = [
        f"表 {state.title} · 命中 {len(rows)} 行（上限 {READ_ROW_CAP} / 全表 {len(state.rows)}）",
        "列：" + "、".join(f"{c.get('label')}({c['id']},{c.get('type')})" for c in cols),
    ]
    preview_cols = cols[:6]
    for row in rows:
        bits = [f"[{row['id']}] {row_summary(state, row)}"]
        for col in preview_cols:
            text = format_cell(col, row["cells"].get(col["id"]))
            if text:
                bits.append(f"{col.get('label')}={text}")
        lines.append("- " + " · ".join(bits))
    if not rows:
        lines.append("（无匹配行）")
    return "\n".join(lines)
