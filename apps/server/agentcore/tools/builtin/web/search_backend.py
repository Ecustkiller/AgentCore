"""Search backend — pluggable web search for built-in tools.

Default implementation talks to a self-hosted SearXNG instance whose engine set
is curated to mainland-China-reachable engines (baidu/360search/sogou/quark, see
``deploy/searxng/settings.yml``) — the public engines (google/ddg/brave) time
out from a China-hosted server. The ``SearchBackend`` protocol allows swapping in
Tavily or another provider without touching the tool layer.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from agentcore.config import settings
from agentcore.tools.builtin.web._net import SEARCH_TIMEOUT

DEFAULT_MAX_RESULTS = 5


@dataclass
class SearchResult:
    title: str
    url: str
    snippet: str


class SearchBackend(Protocol):
    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        ...


def _parse_results(data: dict[str, Any], max_results: int) -> list[SearchResult]:
    """Filter + dedup + truncate a SearXNG JSON payload into SearchResults.

    SearXNG already orders results by cross-engine aggregate score, so we keep
    insertion order: drop entries missing url/title, dedup by normalized url
    (strip ``#fragment`` and trailing ``/`` so the same page from multiple
    engines collapses), then take the top ``max_results``.
    """
    results: list[SearchResult] = []
    seen: set[str] = set()
    for item in data.get("results", []):
        url = (item.get("url") or "").strip()
        title = (item.get("title") or "").strip()
        if not url or not title:
            continue
        key = url.split("#", 1)[0].rstrip("/")
        if key in seen:
            continue
        seen.add(key)
        results.append(SearchResult(title=title, url=url, snippet=item.get("content") or ""))
        if len(results) >= max_results:
            break
    return results


class SearXNGBackend:
    """Search via a self-hosted SearXNG instance (JSON API)."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = (base_url or settings.searxng_url).rstrip("/")

    async def search(
        self, query: str, max_results: int = DEFAULT_MAX_RESULTS
    ) -> list[SearchResult]:
        params = {"q": query, "format": "json", "safesearch": "0"}
        async with httpx.AsyncClient(timeout=SEARCH_TIMEOUT) as client:
            resp = await client.get(f"{self.base_url}/search", params=params)
            resp.raise_for_status()
            data = resp.json()
        return _parse_results(data, max_results)


_backend: SearchBackend | None = None


def get_search_backend() -> SearchBackend:
    global _backend
    if _backend is None:
        _backend = SearXNGBackend()
    return _backend
