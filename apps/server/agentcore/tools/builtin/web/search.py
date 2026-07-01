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
from agentcore.tools.builtin.web.source_domains import default_source_domain_registry
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
                logger.info("tool.web_search_cache_hit", query=query, result_count=len(hit.results))
                self._record_source_domains(context.conversation_id, hit.results)
                return self._success_result(query, hit.results, start, cached=True)
            # 负缓存（案例1 防重搜风暴）：同一查询刚返回空（常见于引擎 CAPTCHA 后 HTTP 200 +
            # 空结果），短时内直接回空、不再打网，避免降级 worker 对同一空查询反复重搜把共享
            # SearXNG 再次打爆。空结果会自然过期，CAPTCHA 大概率解除后才真正重搜。
            if cache.is_recently_empty(query):
                logger.info("tool.web_search_negative_cache_hit", query=query)
                return self._success_result(query, [], start, cached=True)

        try:
            backend = get_search_backend()
            # 工具执行阶段进度 (联网搜索前端展示优化): thread the engine-injected phase
            # callback so the backend can surface「排队中 / 正在检索 / 改用备用引擎」live
            # while this blocking request is in flight. ``None`` on unscoped call
            # sites (tests / evals) — the backend skips it.
            results = await backend.search(
                query, max_results=max_results, on_phase=context.on_phase
            )
        except Exception as e:
            reason = describe_net_error(e)
            logger.warning("tool.web_search_error", query=query, error=reason, error_repr=repr(e))
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"搜索失败：{reason}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )

        if not results:
            # Observability (D5): a LIVE search returned zero results — the passive signal
            # for "search may be degraded" (a CAPTCHA-suspended engine returns HTTP 200 +
            # empty, indistinguishable from a genuine no-hit at the transport layer).
            # Logged at warning so ops can alert on the empty-search RATE in logs/dev.jsonl
            # WITHOUT an active probe that would itself add the CAPTCHA-triggering load this
            # whole change fights. A suppressed repeat logs negative_cache_hit (info) above,
            # so this fires once per genuinely-live empty, not per retry.
            logger.warning("tool.web_search_empty", query=query)

        # Cache the outcome: a non-empty set positively (served for the TTL), an EMPTY
        # set negatively (案例1 防重搜风暴) — a query that just came back empty is
        # suppressed briefly so degraded workers re-issuing it don't restorm the shared
        # SearXNG. The negative marker expires fast so a genuine retry happens once the
        # transient cause (engine CAPTCHA) likely cleared.
        if cache is not None:
            if results:
                cache.put(
                    SearchCacheEntry(
                        query=query,
                        results=results,
                        max_results=max_results,
                        stored_at=time.time(),
                    )
                )
            else:
                cache.note_empty(query)
        self._record_source_domains(context.conversation_id, results)
        return self._success_result(query, results, start, cached=False)

    @staticmethod
    def _record_source_domains(conversation_id: str, results: list[SearchResult]) -> None:
        """Record the domains this search surfaced so a later ``read_url`` of one of
        them is recognised as a legitimate deep-read, not a novel-domain exfil (PI-002).

        No-op when unscoped (``conversation_id == ""``) or empty. Best-effort: a failure
        to record only degrades a future read to "treated as novel" (logged, blocked only
        under the opt-in flag), never breaks the search.
        """
        if not conversation_id or not results:
            return
        domains = {site_of(r.url) for r in results}
        domains.discard("")
        if domains:
            default_source_domain_registry().record(conversation_id, domains)

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
        payload: dict[str, Any] = {"query": query, "results": items}
        if not items:
            # Honesty (D5): an empty set is a *success* (HTTP 200, no transport failure),
            # but the model must NOT read silence as "this doesn't exist" — a
            # CAPTCHA-suspended engine returns HTTP 200 + zero results just the same. Give
            # an explicit, actionable note so the model rephrases / tries another source
            # instead of fabricating an answer or asserting the information is absent.
            payload["note"] = (
                "本次搜索未返回任何结果。可能是查询过于具体/生僻，或搜索引擎暂时受限"
                "（如被限流）。建议换用更通用的关键词重试，或改用其他信息来源；"
                "不要据此断定该信息不存在。"
            )
        output = json.dumps(payload, ensure_ascii=False)
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
        if not items:
            metadata["empty"] = True
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
