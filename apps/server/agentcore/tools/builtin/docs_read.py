"""docs_read — list / get creation-tool 文档 live drafts on a cloud folder."""

from __future__ import annotations

import json
from typing import Any

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.doc.body import sanitize_body
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    ToolRegistration,
    ToolSurface,
)

DOCS_READ_TOOL_NAME = "docs_read"


class DocsReadTool:
    """List or load a folder-hung creation doc (not workspace files, not memory)."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        resident=False,
        catalog_summary="读创作文档",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=DOCS_READ_TOOL_NAME,
            description=(
                "读云文件夹上的创作文档活稿（人在「创作 · 文档」打开的那份）。"
                "省略 doc_id 则列出该文件夹的文档。"
                "不是工作区文件，也不是记忆树。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "文档 id。省略则列出当前云文件夹上的文档。",
                    },
                    "folder_id": {
                        "type": "string",
                        "description": "云文件夹 id。省略则用本对话所挂的云文件夹。",
                    },
                },
            },
            face=ToolFace.DOC,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        from agentcore.db.base import async_session_factory
        from agentcore.db.repositories.docs import DocRepository
        from agentcore.doc.tool_access import (
            NO_DESK,
            NO_USER,
            actor_user_id,
            fail,
            load_visible_doc,
            ok,
            require_cloud_desk,
            resolve_folder_id,
            summary_row,
        )

        user_id = actor_user_id(context)
        if not user_id:
            return fail(NO_USER)
        doc_id = arguments.get("doc_id")
        doc_id = doc_id.strip() if isinstance(doc_id, str) else ""

        async with async_session_factory() as session:
            if doc_id:
                loaded = await load_visible_doc(
                    session, doc_id=doc_id, user_id=user_id, write=False
                )
                if isinstance(loaded, ToolResult):
                    return loaded
                doc, access = loaded
                body = sanitize_body(doc.body)
                payload = {
                    **summary_row(
                        doc, access.folder.name, can_write=access.can_write
                    ),
                    "markdown": body["markdown"],
                }
                output = json.dumps(payload, ensure_ascii=False)
                return ok(
                    output,
                    display={"doc_id": doc.id, "version": doc.version},
                    output_limit=max(len(output), ToolResult._MAX_OUTPUT_LEN),
                )

            folder_id = resolve_folder_id(arguments, context)
            if not folder_id:
                return fail(NO_DESK)
            _desk = await require_cloud_desk(
                session, folder_id=folder_id, user_id=user_id, write=False
            )
            if isinstance(_desk, ToolResult):
                return _desk
            rows = await DocRepository(session).list_visible(
                user_id, folder_id=folder_id
            )
            items = [
                summary_row(doc, name, can_write=can_write)
                for doc, name, can_write in rows
            ]
            if not items:
                return ok(
                    "当前文件夹还没有创作文档。需要新建时用 docs_write。",
                    display={"count": 0},
                )
            payload = {"count": len(items), "docs": items}
            return ok(
                json.dumps(payload, ensure_ascii=False),
                display={"count": len(items)},
            )
