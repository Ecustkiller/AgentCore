"""Built-in tool: web_search (via the configured search backend)."""

import json
import time
from typing import Any

from agentcore.core.logging import get_logger
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.web._net import describe_net_error, site_of
from agentcore.tools.builtin.web.search_backend import SearchResult, get_search_backend
from agentcore.tools.builtin.web.search_cache import (
    SearchCacheEntry,
    default_search_cache_registry,
)
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

        # Conversation-scoped result cache (案例1 #5 检索去重 / 共享检索缓存): a repeat of
        # the same query within the conversation — including across delegated workers,
        # which share the conversation_id — is served from memory instead of re-hitting
        # SearXNG/Tavily, cutting duplicate searches that pressure the shared instance.
        # Unscoped call sites (conversation_id == "") skip the cache entirely.
        cache = (
            default_search_cache_registry().get_or_create(context.conversation_id)
            if context.conversation_id
            else None
        )
        if cache is not None:
            hit = cache.get(query, min_results=max_results)
            if hit is not None:
                logger.info(
                    "tool.web_search_cache_hit", query=query, result_count=len(hit.results)
                )
                return self._success_result(query, hit.results, start, cached=True)

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

        # Cache only successful, non-empty result sets — an empty result is left to
        # re-search (it may have been a transient miss), mirroring read_url's
        # "only cache successful fetches" rule.
        if cache is not None and results:
            cache.put(
                SearchCacheEntry(
                    query=query,
                    results=results,
                    max_results=max_results,
                    stored_at=time.time(),
                )
            )
        return self._success_result(query, results, start, cached=False)

    def _success_result(
        self,
        query: str,
        results: list[SearchResult],
        start: float,
        *,
        cached: bool,
    ) -> ToolResult:
        """Build the (identical-shape) success ToolResult for a live or cached hit."""
        items = [{"title": r.title, "url": r.url, "snippet": r.snippet} for r in results]
        output = json.dumps({"query": query, "results": items}, ensure_ascii=False)
        citations = [
            {"url": r.url, "title": r.title, "snippet": r.snippet, "site": site_of(r.url)}
            for r in results
        ]
        # Render-oriented twin of ``output`` (工具结果富渲染): the client shows the
        # hits as source-style cards (favicon · title · snippet) instead of raw
        # JSON. Carries ``site`` (the parsed display host) so the card needs no
        # client-side URL parsing.
        display = {
            "query": query,
            "results": [
                {"title": r.title, "url": r.url, "snippet": r.snippet, "site": site_of(r.url)}
                for r in results
            ],
        }
        metadata: dict[str, Any] = {"result_count": len(items)}
        if cached:
            metadata["cached"] = True
        return ToolResult(
            tool_call_id="",
            success=True,
            output=output,
            duration_ms=int((time.monotonic() - start) * 1000),
            output_limit=_OUTPUT_LIMIT,
            metadata=metadata,
            citations=citations or None,
            display=display,
        )
