"""Built-in tool: web_search (via the configured search backend)."""

import json
import time
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.web._net import describe_net_error
from agentcore.tools.builtin.web.search_backend import get_search_backend
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema

logger = get_logger(__name__)

_DEFAULT_MAX_RESULTS = 8
_MAX_RESULTS_CAP = 12
# Structured JSON results stay readable up to ~12 hits; lift the default 4000
# model-facing budget so a full result set is never truncated into invalid JSON.
_OUTPUT_LIMIT = 8000


class WebSearchTool:
    """Search the web via a self-hosted SearXNG instance."""

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="web_search",
            description=(
                "搜索互联网获取实时信息（新闻、事实、天气、公司信息、概念定义等），"
                "面向中国大陆可达的搜索引擎。返回多条按相关性排序的结果，每条含标题、"
                "链接与内容摘要——多数问题用这些摘要即可作答并据此引用来源，是首选联网"
                "工具。只有当确需某条结果的完整正文时，再用 read_url 深读。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索查询词"},
                    "max_results": {
                        "type": "integer",
                        "description": "返回结果数量上限，默认 8，最多 12",
                    },
                },
                "required": ["query"],
            },
            category=ToolCategory.RESEARCH,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        query = (arguments.get("query") or "").strip()
        if not query:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="缺少必填参数：query",
                duration_ms=0,
            )

        try:
            raw = int(arguments.get("max_results", _DEFAULT_MAX_RESULTS))
            max_results = max(1, min(raw, _MAX_RESULTS_CAP))
        except (TypeError, ValueError):
            max_results = _DEFAULT_MAX_RESULTS

        try:
            backend = get_search_backend()
            results = await backend.search(query, max_results=max_results)
        except Exception as e:
            reason = describe_net_error(e)
            logger.warning(
                "tool.web_search_error", query=query, error=reason, error_repr=repr(e)
            )
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"搜索失败：{reason}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        items = [{"title": r.title, "url": r.url, "snippet": r.snippet} for r in results]
        output = json.dumps({"query": query, "results": items}, ensure_ascii=False)
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=_OUTPUT_LIMIT,
            metadata={"result_count": len(items)},
        )
