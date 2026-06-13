"""Web search tool using DuckDuckGo HTML search."""

import time
from typing import Any

import httpx

from agentcore.core.types import ToolApproval, ToolCategory
from agentcore.tools.protocol import ToolContext, ToolResult, ToolSchema


class WebSearchTool:
    """Web search tool that queries DuckDuckGo."""

    def __init__(self):
        self._client = httpx.AsyncClient(
            timeout=15.0,
            headers={"User-Agent": "AgentCore/0.1 (search tool)"},
        )

    @property
    def schema(self) -> ToolSchema:
        return ToolSchema(
            name="web_search",
            description=(
                "Search the web for information. "
                "Returns top results with titles, URLs, and snippets."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query",
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of results to return",
                        "default": 5,
                    },
                },
                "required": ["query"],
            },
            category=ToolCategory.RESEARCH,
            approval=ToolApproval.NEVER,
        )

    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        start = time.monotonic()
        query = arguments.get("query", "")
        max_results = arguments.get("max_results", 5)

        if not query:
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error="Query parameter is required",
                duration_ms=0,
            )

        try:
            response = await self._client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": query},
            )
            response.raise_for_status()
            results = self._parse_results(response.text, max_results)
            duration_ms = int((time.monotonic() - start) * 1000)

            if not results:
                return ToolResult(
                    tool_call_id="",
                    success=True,
                    output="No results found.",
                    duration_ms=duration_ms,
                )

            output_lines = [f"Search results for: {query}\n"]
            for i, r in enumerate(results, 1):
                output_lines.append(f"{i}. {r['title']}")
                output_lines.append(f"   URL: {r['url']}")
                output_lines.append(f"   {r['snippet']}\n")

            return ToolResult(
                tool_call_id="",
                success=True,
                output="\n".join(output_lines),
                duration_ms=duration_ms,
            )

        except httpx.HTTPError as e:
            duration_ms = int((time.monotonic() - start) * 1000)
            return ToolResult(
                tool_call_id="",
                success=False,
                output="",
                error=f"Search request failed: {e}",
                duration_ms=duration_ms,
            )

    def _parse_results(self, html: str, max_results: int) -> list[dict]:
        """Simple HTML parsing for DuckDuckGo results."""
        results = []
        # DuckDuckGo HTML results have class="result__a" for links
        # and class="result__snippet" for descriptions
        import re

        link_pattern = re.compile(
            r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', re.DOTALL
        )
        snippet_pattern = re.compile(
            r'class="result__snippet"[^>]*>(.*?)</(?:span|td)', re.DOTALL
        )

        links = link_pattern.findall(html)
        snippets = snippet_pattern.findall(html)

        for i, (url, title) in enumerate(links[:max_results]):
            title_clean = re.sub(r"<[^>]+>", "", title).strip()
            snippet = ""
            if i < len(snippets):
                snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()

            if title_clean and url:
                results.append({
                    "title": title_clean,
                    "url": url,
                    "snippet": snippet,
                })

        return results
