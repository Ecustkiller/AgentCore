"""table_ops — apply a closed batch of table mutations on the server DB.

Available ONLY in a 表格会话 (``ToolContext.table_id`` set). Ordinary chats get a
clean error. Human REST and this tool share :func:`apply_ops` — L2/L3 with
``confirm=false`` dry-run and do not persist.
"""

from __future__ import annotations

from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.table.constants import OP_KINDS, STRUCT_OPS
from agentcore.table.ops import apply_ops
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_CEO_ONLY,
    CeoWire,
    ToolRegistration,
    ToolSurface,
)

logger = get_logger(__name__)

TABLE_OPS_TOOL_NAME = "table_ops"
_NO_TABLE = "table_ops 仅在表格会话中可用：当前会话没有绑定表格。"


class TableOpsTool:
    """Apply a batch of structured ops to the bound table's DB snapshot."""

    registration = ToolRegistration(
        surface=ToolSurface.CEO_ORCHESTRATION,
        audience=AUDIENCE_CEO_ONLY,
        ceo_wire=CeoWire.TABLE,
        resident=False,
        catalog_summary="改当前表格",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=TABLE_OPS_TOOL_NAME,
            description=(
                "改当前表格：加/改/删列、写入或改格子、删行、改视图、撤销上一批。"
                "仅表格会话可用。与用户同一套操作。"
                "少量改格直接落库；改列、一次改≥21行、删列/删行/新增行须 confirm=true，"
                "否则只返回 dryRun 摘要、不改表。"
                "一次最多改 200 行；表最多 5000 行。改列请带当前 schema_baseline。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "ops": {
                        "type": "array",
                        "description": "要应用的操作批次。结构变更会排在数据变更之前。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {
                                    "type": "string",
                                    "enum": list(OP_KINDS),
                                    "description": "操作类型。",
                                },
                            },
                            "required": ["op"],
                            "additionalProperties": True,
                        },
                    },
                    "confirm": {
                        "type": "boolean",
                        "description": (
                            "L2/L3 确认落库。false/省略时只 dryRun。"
                            "用户已口头同意后再传 true。"
                        ),
                    },
                    "schema_baseline": {
                        "type": "integer",
                        "description": "改列时传入当前 schema_version；不匹配则拒绝。",
                    },
                },
                "required": ["ops"],
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
        ops = arguments.get("ops")
        if not isinstance(ops, list) or not ops:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="table_ops 需要非空的 ops 数组（至少一个操作）。",
            )
        confirm = bool(arguments.get("confirm"))
        baseline = arguments.get("schema_baseline")
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories.tables import TableRepository

        async with async_session_factory() as session:
            repo = TableRepository(session)
            state = await repo.get_state(table_id, user_id=context.user_id)
            if state is None:
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error="表格不存在或无权访问。",
                )
            if baseline is not None and any(
                (op.get("op") in STRUCT_OPS) for op in ops if isinstance(op, dict)
            ):
                try:
                    expected = int(baseline)
                except (TypeError, ValueError):
                    expected = -1
                if expected != state.schema_version:
                    return ToolResult(
                        tool_call_id="",
                        success=False,
                        output="",
                        error="表格结构已更新，请刷新后再改列。",
                    )
            logger.info(
                "table.ops_apply",
                run_id=context.run_id,
                table_id=table_id,
                op_count=len(ops),
                confirm=confirm,
            )
            result = apply_ops(state, ops, confirm=confirm)
            if result.refused or (not result.ok and result.error):
                return ToolResult(
                    tool_call_id="",
                    success=False,
                    output="",
                    error=result.error or "表格操作失败。",
                )
            if result.needs_confirmation or result.state is None:
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output=(
                        f"未改表，需要确认（{result.level}）：{result.summary}。"
                        "用户同意后请以 confirm=true 再调用。"
                    ),
                )
            await repo.persist_state(
                result.state,
                touched_row_ids=result.touched_row_ids,
                deleted_row_ids=result.deleted_row_ids,
            )
            fresh = await repo.get_state(table_id, user_id=context.user_id)
        extra = ""
        if fresh is not None:
            extra = f" 现在 {len(fresh.rows)} 行，schema_version={fresh.schema_version}。"
        return ToolResult(
            tool_call_id="",
            success=True,
            output=f"已应用（{result.level}）：{result.summary}。{extra}".strip(),
        )
