"""Built-in tool: web_search (via the configured search backend)."""

import json
import re
import time
from typing import Any
from urllib.parse import urlparse

from agentcore.core.citation_tier import citation_tier_for_url, stamp_citation_tier
from agentcore.core.logging import get_logger
from agentcore.core.net import describe_net_error, site_of
from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.builtin.web.search_backend import (
    SearchResult,
    get_search_backend,
    infer_search_language,
    track_phase_durations,
)
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
# Empty-result honesty: queries with more than this many whitespace-separated
# tokens get an explicit "trim to 2–4 core words" tip (mirrors debate SEARCH_QUERY_RULE).
_VERBOSE_QUERY_WORD_THRESHOLD = 4

# A3 query contract (检索与交付约束前置提案): mechanical limits at the tool boundary.
# Tunable constants — calibrated near log P95; not silent-rewritten on overflow.
_QUERY_LATIN_WORD_LIMIT = 6
_QUERY_CJK_CHAR_LIMIT = 32
# Quoted phrases (error strings / citations) are exempt from the word/char budget.
_QUOTED_PHRASE_RE = re.compile(r'"[^"]*"|\'[^\']*\'')
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _query_word_count(query: str) -> int:
    """Count whitespace-separated tokens in a search query (no NLP / rewrite)."""
    return len(query.split())


def _unquoted_span(query: str) -> str:
    """Query text with quoted phrases removed (A3 quote exemption)."""
    return _QUOTED_PHRASE_RE.sub(" ", query or "")


def validate_search_query(query: str) -> str | None:
    """A3: deterministic query-contract check. Returns an error message, or None if ok.

    Latin (no CJK in the unquoted span): core-word count ≤ ``_QUERY_LATIN_WORD_LIMIT``.
    CJK / mixed: non-whitespace character count ≤ ``_QUERY_CJK_CHAR_LIMIT``.
    Quoted phrases are exempt. Never rewrites the query — reject + tip only.
    """
    unquoted = _unquoted_span(query).strip()
    if not unquoted:
        # Entire query was quoted phrases — always allowed.
        return None
    tip = (
        "请删去最具体的限定词（如案号/机构名/年份/金额），"
        "改用 2–4 个核心词重试；需要搜原文/报错时请用引号包住短语。"
    )
    if _CJK_RE.search(unquoted):
        char_count = sum(1 for ch in unquoted if not ch.isspace())
        if char_count > _QUERY_CJK_CHAR_LIMIT:
            return (
                f"查询过长（未加引号部分 {char_count} 字，上限 "
                f"{_QUERY_CJK_CHAR_LIMIT}）。{tip}"
            )
        return None
    word_count = _query_word_count(unquoted)
    if word_count > _QUERY_LATIN_WORD_LIMIT:
        return (
            f"查询词过多（未加引号部分 {word_count} 个词，上限 "
            f"{_QUERY_LATIN_WORD_LIMIT}）。{tip}"
        )
    return None


def _is_debate_run(run_id: str) -> bool:
    """Debate carve-out seam: moderator/debater run_ids are ``debate_*`` (existing convention)."""
    return (run_id or "").startswith("debate_")


def _empty_result_note(query: str) -> str:
    """Honest, actionable note when a live/cached search returned zero hits.

    Does not rewrite the query or re-search — feedback only, at the failure site.
    """
    base = (
        "本次搜索未返回任何结果。可能是查询过于具体/生僻，或搜索引擎暂时受限"
        "（如被限流）。不要据此断定该信息不存在。"
    )
    if _query_word_count(query) > _VERBOSE_QUERY_WORD_THRESHOLD:
        tip = (
            "当前查询词明显过多——建议删去最具体的限定词（如案号/机构名/年份/金额），"
            "改用 2–4 个核心词重试。"
        )
    else:
        tip = "建议换用更通用或同义的关键词重试，或改用其他信息来源。"
    return f"{base}{tip}"


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

        # A3: reject oversized queries at the tool boundary (no silent rewrite).
        contract_err = validate_search_query(query)
        if contract_err is not None:
            logger.info("tool.web_search_query_rejected", query=query, reason="query_contract")
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=contract_err,
                duration_ms=int((time.monotonic() - start) * 1000),
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
        # Task-language proxy: pin SearXNG/Tavily locale so IP / default_lang=auto
        # cannot hijack 中文调研 into Japanese SERPs.
        language = infer_search_language(query)
        # A4 debate carve-out: debate runs keep exact keys (no Latin word-order share).
        exact_cache = _is_debate_run(context.run_id)

        cache = (
            default_search_cache_registry().get_or_create(context.conversation_id)
            if context.conversation_id
            else None
        )
        if cache is not None:
            hit = cache.get(
                query, min_results=max_results, language=language, exact=exact_cache
            )
            if hit is not None:
                logger.info("tool.web_search_cache_hit", query=query, result_count=len(hit.results))
                self._record_source_domains(context.conversation_id, hit.results)
                return self._success_result(query, hit.results, start, cached=True)
            # 负缓存（案例1 防重搜风暴）：同一查询刚返回空（常见于引擎 CAPTCHA 后 HTTP 200 +
            # 空结果），短时内直接回空、不再打网，避免降级 worker 对同一空查询反复重搜把共享
            # SearXNG 再次打爆。空结果会自然过期，CAPTCHA 大概率解除后才真正重搜。
            if cache.is_recently_empty(query, language=language, exact=exact_cache):
                logger.info("tool.web_search_negative_cache_hit", query=query)
                return self._success_result(query, [], start, cached=True)

        # A6: wrap the existing on_phase channel to emit structured phase durations.
        on_phase, finish_phases = track_phase_durations(context.on_phase)
        try:
            backend = get_search_backend()
            # 工具执行阶段进度 (联网搜索前端展示优化): thread the engine-injected phase
            # callback so the backend can surface「排队中 / 正在检索 / 改用备用引擎」live
            # while this blocking request is in flight. ``None`` on unscoped call
            # sites (tests / evals) — the backend skips it; duration logging still runs
            # when phases fire.
            results = await backend.search(
                query,
                max_results=max_results,
                on_phase=on_phase,
                language=language,
            )
        except Exception as e:
            finish_phases()
            reason = describe_net_error(e)
            logger.warning("tool.web_search_error", query=query, error=reason, error_repr=repr(e))
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"搜索失败：{reason}",
                duration_ms=int((time.monotonic() - start) * 1000),
            )
        finish_phases()

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
                        language=language,
                    ),
                    exact=exact_cache,
                )
            else:
                cache.note_empty(query, language=language, exact=exact_cache)
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
        """Build the (identical-shape) success ToolResult for a live or cached hit.

        硬拦（``blocked``）域名在检索出口剔除，不进模型可见结果与 citations；低质
        （``weak``）仍回模型；可被 ``#rN`` 显式引用并带弱源徽标（P2）。
        """
        kept: list[SearchResult] = []
        blocked_hosts: list[str] = []
        for r in results:
            tier = citation_tier_for_url(r.url)
            if tier == "blocked":
                host = site_of(r.url) or _host_hint(r.url)
                if host:
                    blocked_hosts.append(host)
                continue
            kept.append(r)

        items = [{"title": r.title, "url": r.url, "snippet": r.snippet} for r in kept]
        hosts = [site_of(r.url) for r in kept if site_of(r.url)]
        payload: dict[str, Any] = {"query": query, "results": items}
        if not items:
            # Honesty (D5): an empty set is a *success* (HTTP 200, no transport failure),
            # but the model must NOT read silence as "this doesn't exist" — a
            # CAPTCHA-suspended engine returns HTTP 200 + zero results just the same. Give
            # an explicit, actionable note so the model rephrases / tries another source
            # instead of fabricating an answer or asserting the information is absent.
            # Verbose queries (>4 tokens) get a trim-to-2–4 tip at the failure site
            # (system-prompt SEARCH_QUERY_RULE is too far from the empty hit to act on).
            payload["note"] = _empty_result_note(query)
        output = json.dumps(payload, ensure_ascii=False)
        citations = [
            stamp_citation_tier(
                {
                    "url": r.url,
                    "title": r.title,
                    "snippet": r.snippet,
                    "site": site_of(r.url),
                    "query": query,
                }
            )
            for r in kept
        ]
        # Render-oriented twin of ``output`` (工具结果富渲染): the client shows the
        # hits as source-style cards (favicon · title · snippet) instead of raw
        # JSON. Carries ``site`` (the parsed display host) so the card needs no
        # client-side URL parsing.
        display = {
            "query": query,
            "results": [
                {"title": r.title, "url": r.url, "snippet": r.snippet, "site": site_of(r.url)}
                for r in kept
            ],
        }
        metadata: dict[str, Any] = {
            "result_count": len(items),
            "query": query,
            "hosts": hosts,
        }
        if blocked_hosts:
            metadata["blocked_hosts"] = blocked_hosts
        if cached:
            metadata["cached"] = True
        if not items:
            metadata["empty"] = True
        # 检索观测：query + 命中域名（含被硬拦剔除的），便于还原「搜了什么 / 拿回什么」。
        logger.info(
            "tool.web_search",
            query=query,
            hosts=hosts,
            result_count=len(items),
            blocked_count=len(blocked_hosts),
            cached=cached,
        )
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


def _host_hint(url: str) -> str:
    """Best-effort host for blocked-hit logging when ``site_of`` is empty."""
    return urlparse(url if "://" in url else f"https://{url}").netloc.removeprefix("www.")
