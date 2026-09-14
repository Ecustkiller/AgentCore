"""docs_write — create / save creation-tool 文档 live drafts (not publish)."""

from __future__ import annotations

from typing import Any

from agentcore.core.types import ToolApproval, ToolFace
from agentcore.doc.body import MAX_MARKDOWN_CHARS, sanitize_body
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    ToolRegistration,
    ToolSurface,
)

DOCS_WRITE_TOOL_NAME = "docs_write"


class DocsWriteTool:
    """Write the same Markdown live draft the human editor opens. Does not publish."""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        resident=False,
        catalog_summary="写创作文档",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name=DOCS_WRITE_TOOL_NAME,
            description=(
                "写云文件夹上的创作文档活稿，与用户编辑器同一份 Markdown。"
                "省略 doc_id 则新建。改已有文档时带上 docs_read 的 version 作 baseline。"
                "写活稿不会出现在客户公开页。不是工作区 file_write，也不是记忆树。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "markdown": {
                        "type": "string",
                        "description": (
                            f"整篇 Markdown 活稿。省略则保留原文（新建则为空）。"
                            f"最多 {MAX_MARKDOWN_CHARS} 字。"
                        ),
                    },
                    "doc_id": {
                        "type": "string",
                        "description": "已有文档 id。省略则新建。",
                    },
                    "title": {
                        "type": "string",
                        "description": "标题。新建时省略则为「未命名文档」。",
                    },
                    "baseline": {
                        "type": "integer",
                        "description": "docs_read 得到的 version；不匹配则拒绝写入。省略则覆盖。",
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
            DEFAULT_TITLE,
            NO_DESK,
            NO_USER,
            TOO_LONG,
            actor_user_id,
            fail,
            load_visible_doc,
            ok,
            require_cloud_desk,
            resolve_folder_id,
        )

        user_id = actor_user_id(context)
        if not user_id:
            return fail(NO_USER)

        raw_md = arguments.get("markdown")
        if raw_md is None:
            markdown: str | None = None
        elif isinstance(raw_md, str):
            markdown = raw_md
        else:
            return fail("markdown 必须是字符串。")
        if markdown is not None and len(markdown) > MAX_MARKDOWN_CHARS:
            return fail(TOO_LONG)

        title_raw = arguments.get("title")
        title = title_raw.strip() if isinstance(title_raw, str) else None
        if title == "":
            title = DEFAULT_TITLE

        doc_id = arguments.get("doc_id")
        doc_id = doc_id.strip() if isinstance(doc_id, str) else ""
        baseline = arguments.get("baseline")
        if baseline is not None:
            try:
                baseline = int(baseline)
            except (TypeError, ValueError):
                return fail("baseline 必须是整数。")

        async with async_session_factory() as session:
            repo = DocRepository(session)
            if doc_id:
                if markdown is None and title is None:
                    return fail("改已有文档需要 markdown 或 title。")
                loaded = await load_visible_doc(
                    session, doc_id=doc_id, user_id=user_id, write=True
                )
                if isinstance(loaded, ToolResult):
                    return loaded
                doc, access = loaded
                if title is not None:
                    doc = await repo.update_meta(doc, title=title)
                if markdown is not None:
                    doc, conflict = await repo.save_body(
                        doc,
                        body=sanitize_body(markdown),
                        baseline=baseline,
                    )
                    if conflict:
                        return fail(
                            f"版本冲突：当前 version={doc.version}。"
                            "请 docs_read 后带 baseline 再写。"
                        )
                return ok(
                    f"已写入「{doc.title}」version={doc.version}。未发布。",
                    display={
                        "doc_id": doc.id,
                        "version": doc.version,
                        "title": doc.title,
                    },
                )

            folder_id = resolve_folder_id(arguments, context)
            if not folder_id:
                return fail(NO_DESK)
            _desk = await require_cloud_desk(
                session, folder_id=folder_id, user_id=user_id, write=True
            )
            if isinstance(_desk, ToolResult):
                return _desk
            doc = await repo.create(
                user_id=user_id,
                folder_id=folder_id,
                title=title or DEFAULT_TITLE,
            )
            if markdown:
                doc, _conflict = await repo.save_body(
                    doc,
                    body=sanitize_body(markdown),
                    baseline=doc.version,
                )
            return ok(
                f"已新建「{doc.title}」（id={doc.id}，version={doc.version}）。未发布。",
                display={
                    "doc_id": doc.id,
                    "version": doc.version,
                    "title": doc.title,
                },
            )
