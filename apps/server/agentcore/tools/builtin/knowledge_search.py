"""search_knowledge — agentic, on-demand retrieval over the user's documents tree.

《Agent记忆与知识系统》「否决」表否决「向量 chunk 自动灌 prompt」（与「文件随时变」
不合；agentic 自取永远新鲜）。本工具走的是文档自己指的那条路：模型**主动调用**
才看得到结果，结果只在本次调用里可见，不进每回合 prompt，也不写回任何记忆。

声明为 BUILTIN / AUDIENCE_BOTH，但默认**不在 roster 里**：opt-in
``AGENTCORE_KNOWLEDGE_SEARCH_ENABLED=1``。在 roster 层条件加载（而非 registry
事后过滤），保证 registry / 能力目录 / 开场表读到的声明集完全一致。
生成 / 最后修订 2026-11-04。
"""

from __future__ import annotations

from typing import Any

from agentcore.config import settings
from agentcore.core.types import ToolApproval, ToolFace
from agentcore.db.base import async_session_factory
from agentcore.db.repositories import DocumentRepository
from agentcore.documents.knowledge_search import rank_and_render, search_terms
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema
from agentcore.tools.registration import (
    AUDIENCE_BOTH,
    FileProductsContract,
    ToolRegistration,
    ToolSurface,
)

_EMPTY_QUERY = "请提供关键词。一次 1–2 个词；词多易空、可另开短查询。引号包精确短语。"
_SOFT_MISS = "知识树里没找到匹配内容（可能没有这条笔记、已删除，或被标记为「这条不对」）。"
_SCOPE_NOTE = "按需检索结果，不会自动进入后续对话；需要全文请让用户打开文件页"
_OUTPUT_LIMIT = 12000


class KnowledgeSearchTool:
    """按需检索用户写的规则 / 笔记 / 文档正文（不自动注入 prompt）。"""

    registration = ToolRegistration(
        surface=ToolSurface.BUILTIN,
        audience=AUDIENCE_BOTH,
        file_products=FileProductsContract.READ_ONLY,
        catalog_summary="查你写的规则与笔记",
        blurb="按需检索知识树，命中给片段",
    )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="search_knowledge",
            description=(
                "按需检索用户知识树（自己写的规则、长期笔记、文档）里的正文，"
                "返回命中片段。只有主动调用才会看到结果，不会自动出现在上下文里。"
                "适合查「我之前写过什么规矩 / 某个项目记了什么」；查旧对话用 "
                "search_conversations，查工作区文件用 grep。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "关键词，多个词按 AND 匹配；引号可包精确短语。",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "最多返回几条命中（1–20）。",
                        "default": 8,
                    },
                },
                "required": ["query"],
            },
            face=ToolFace.SEARCH,
            approval=ToolApproval.NEVER,
        )

    async def execute(
        self, arguments: dict[str, Any], context: ToolContext
    ) -> ToolResult:
        query = str(arguments.get("query") or "").strip()
        terms = search_terms(query)
        if not terms:
            return ToolResult(
                tool_call_id="",
                success=True,
                output=_EMPTY_QUERY,
                display={"result_count": 0, "terms": []},
            )

        raw_limit = arguments.get("limit") or settings.knowledge_search_max_results
        try:
            limit = max(1, min(int(raw_limit), 20))
        except (TypeError, ValueError):
            limit = settings.knowledge_search_max_results
        candidate_limit = limit * settings.knowledge_search_candidate_multiplier

        async with async_session_factory() as session:
            rows = await DocumentRepository(session).search_knowledge(
                context.user_id, query, limit=candidate_limit
            )
        hits = rank_and_render(
            rows,
            terms,
            radius=settings.knowledge_search_snippet_radius,
            limit=limit,
        )
        if not hits:
            return ToolResult(
                tool_call_id="",
                success=True,
                output=_SOFT_MISS,
                display={"result_count": 0, "terms": terms},
            )

        lines = [f"找到 {len(hits)} 条知识文档（{_SCOPE_NOTE}）：", ""]
        for hit in hits:
            scope = "全局" if hit.folder_id is None else f"工作区 {hit.folder_id}"
            updated = hit.updated_at.isoformat() if hit.updated_at else "—"
            lines.append(
                f"- `{hit.name}` · {hit.role} · {scope} · 更新 {updated} · "
                f"id={hit.document_id}"
            )
            if hit.snippet:
                lines.append(f"  片段：{hit.snippet}")
        output = "\n".join(lines)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            output_limit=max(len(output), _OUTPUT_LIMIT),
            display={"result_count": len(hits), "terms": terms},
        )
